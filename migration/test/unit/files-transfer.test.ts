// Unit tests for moving file-store objects to strategies-content: planning, paged streaming, per-site logs and hash checks.
import { createHash } from 'node:crypto';

import type { Logger } from '@opt2/platform/logging';
import { tenantIdForSite, type MetadataTx, type TenantDb } from '@opt2/platform/tenancy';
import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { MigrationContext } from '../../src/context.js';
import { MANIFEST_PAGE_ROWS, type ManifestEntry, type ManifestKey } from '../../src/files/manifest.js';
import type { StoredVariant } from '../../src/files/names.js';
import { FileHashMismatchError, planObjects, transferFiles, type PlanOptions } from '../../src/files/transfer.js';
import { BridgeError, BridgeHashMismatchError, type BridgeClient, type LegacyFileBytes } from '../../src/legacy/bridge.js';
import type { LegacyDb } from '../../src/legacy/legacy-db.js';
import type { OwnersClient, PutObjectParams } from '../../src/owners/client.js';

const SNAP_DB = 'muradb_opt2_snap_5';
const FID_A = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_B = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_C = 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_D = 'D1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const SELECT_MANIFEST = 'SELECT site_id, path, file_id, variant, ext, size, sha256, orphan FROM migration.file_manifest';
const MANIFEST_ORDER = 'ORDER BY site_id COLLATE "C", path COLLATE "C"';
const FIRST_PAGE_SQL = `${SELECT_MANIFEST} WHERE snapshot_seq = $1 ${MANIFEST_ORDER} LIMIT $2`;
const NEXT_PAGE_SQL = `${SELECT_MANIFEST} WHERE snapshot_seq = $1 AND (site_id COLLATE "C", path COLLATE "C") > ($2, $3) ${MANIFEST_ORDER} LIMIT $4`;
const OWNERS_SQL = 'SELECT [fileID], [siteID] FROM [dbo].[tfiles];';
const TYPES_SQL = 'SELECT [fileID], [contentType], [contentSubType], [fileExt] FROM [dbo].[tfiles];';
const UMBRELLA = 'umbrella';

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const contentOf = (path: string): Buffer => Buffer.from(`bytes of ${path}`);
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const keyOrder = (a: ManifestKey, b: ManifestKey): number => byteOrder(a.siteId, b.siteId) || byteOrder(a.path, b.path);
const keyOf = ({ siteId, path }: ManifestEntry): ManifestKey => ({ siteId, path });

/** Manifest entry of `<siteId>/cache/file/<name>` in snapshot 5, hashed over contentOf its path. */
function entry(siteId: string, name: string, orphan = false): ManifestEntry {
  const dot = name.lastIndexOf('.');
  const path = `${siteId}/cache/file/${name}`;
  const bytes = contentOf(path);
  return {
    snapshotSeq: 5,
    siteId,
    path,
    name,
    fileId: name.slice(0, 35),
    variant: name.slice(35, dot) as StoredVariant,
    ext: name.slice(dot + 1),
    size: bytes.byteLength,
    sha256: sha(bytes),
    orphan,
  };
}

interface TfilesRow {
  fileID: string;
  siteID: string | null;
  contentType: string | null;
  contentSubType: string | null;
  fileExt: string | null;
}

const tfile = (fileID: string, siteID: string | null, type: [string | null, string | null, string | null] = ['image', 'jpeg', 'jpg']): TfilesRow => ({
  fileID,
  siteID,
  contentType: type[0],
  contentSubType: type[1],
  fileExt: type[2],
});

/** Migration database of snapshot 5, its manifest answered in keyset pages; `events` records page reads. */
function migrationDb(entries: readonly ManifestEntry[], events: string[]) {
  const statements: { sql: string; values: unknown[]; returned: number }[] = [];
  const sorted = entries.toSorted(keyOrder);
  const answer = (sql: string, values: unknown[]): QueryResultRow[] => {
    if (sql === 'SELECT database_name FROM migration.snapshot WHERE seq = $1') return values[0] === 5 ? [{ database_name: SNAP_DB }] : [];
    if (sql !== FIRST_PAGE_SQL && sql !== NEXT_PAGE_SQL) throw new Error(`unexpected statement: ${sql}`);
    const after = sql === NEXT_PAGE_SQL ? { siteId: values[1] as string, path: values[2] as string } : undefined;
    const limit = values[sql === NEXT_PAGE_SQL ? 3 : 1] as number;
    events.push('page');
    return sorted
      .filter((found) => found.snapshotSeq === values[0] && (after === undefined || keyOrder(found, after) > 0))
      .slice(0, limit)
      .map((found) => ({
        site_id: found.siteId,
        path: found.path,
        file_id: found.fileId,
        variant: found.variant,
        ext: found.ext,
        size: String(found.size),
        sha256: found.sha256,
        orphan: found.orphan,
      }));
  };
  const tx = {
    schema: 'migration',
    kind: 'metadata',
    onCommit: () => undefined,
    query: (sql: string, values: unknown[] = []) => {
      const rows = answer(sql, values);
      statements.push({ sql, values, returned: rows.length });
      return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult);
    },
  } as unknown as MetadataTx;
  const db = {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('file transfer never runs in a tenant transaction')),
    withMetadata: <T>(fn: (metadata: MetadataTx) => Promise<T>): Promise<T> => fn(tx),
    end: () => Promise.resolve(),
  } as unknown as TenantDb;
  return { db, statements };
}

/** Legacy SQL Server whose restored databases each hold `tfiles` rows. */
function legacyOf(databases: Record<string, TfilesRow[]>) {
  const queries: { database: string; sql: string }[] = [];
  const database = vi.fn((name: string) => {
    const rows = databases[name];
    if (rows === undefined) return Promise.reject(new Error(`Cannot open database "${name}"`));
    const request = () => ({
      query: (sql: string) => {
        queries.push({ database: name, sql });
        if (sql === OWNERS_SQL) return Promise.resolve({ recordset: rows.map(({ fileID, siteID }) => ({ fileID, siteID })) });
        if (sql === TYPES_SQL) {
          return Promise.resolve({
            recordset: rows.map(({ fileID, contentType, contentSubType, fileExt }) => ({ fileID, contentType, contentSubType, fileExt })),
          });
        }
        return Promise.reject(new Error(`unexpected legacy statement: ${sql}`));
      },
    });
    return Promise.resolve({ request });
  });
  return { legacy: { database } as unknown as LegacyDb, queries };
}

/** Bridge serving each path's contentOf bytes, unless `answers` overrides a path. */
function bridgeOf(events: string[], answers: Record<string, LegacyFileBytes | Error> = {}) {
  const filesGet = vi.fn((siteId: string, name: string) => {
    const path = `${siteId}/cache/file/${name}`;
    events.push(`get ${path}`);
    const answer = answers[path];
    if (answer instanceof Error) return Promise.reject(answer);
    const bytes = contentOf(path);
    return Promise.resolve(answer ?? { bytes, sha256: sha(bytes) });
  });
  return { bridge: { filesGet } as unknown as BridgeClient, filesGet };
}

/** strategies-content upload that already holds the `held` keys. */
function ownersOf(held: readonly string[] = []) {
  const stored = new Set(held);
  const putObject = vi.fn((params: PutObjectParams, bytes: Uint8Array) => {
    const key = `${params.tenantId}/${params.fileId}${params.variant}.${params.ext}`;
    const created = !stored.has(key);
    stored.add(key);
    return Promise.resolve({ key, size: bytes.byteLength, sha256: params.sha256, created, writePositions: {} });
  });
  return { owners: { putObject } as unknown as OwnersClient, putObject };
}

/** Transfer context over `entries`, the snapshot's `tfiles` rows and optional bridge answers. */
function store(entries: readonly ManifestEntry[], tfiles: TfilesRow[], opts: { held?: string[]; answers?: Record<string, LegacyFileBytes | Error> } = {}) {
  const events: string[] = [];
  const db = migrationDb(entries, events);
  const legacy = legacyOf({ [SNAP_DB]: tfiles, muradb_restore: tfiles });
  const bridge = bridgeOf(events, opts.answers);
  const owners = ownersOf(opts.held);
  const info = vi.fn();
  const config = { umbrellaSiteId: UMBRELLA, fileStore: { flvRenditionExt: 'jpg' } } as unknown as MigrationContext['config'];
  const ctx = { db: db.db, legacy: legacy.legacy, bridge: bridge.bridge, owners: owners.owners, logger: { info } as unknown as Logger, config };
  return { ctx, events, statements: db.statements, queries: legacy.queries, filesGet: bridge.filesGet, putObject: owners.putObject, info };
}

/** Two sites: default holds an image with a rendition, an orphan and a copy owned by tenant-a; tenant-a holds one PDF. */
function twoSites() {
  const entries = [
    entry('tenant-a', `${FID_C}.pdf`),
    entry('default', `${FID_A}.jpg`),
    entry('default', `${FID_A}_small.jpg`),
    entry('default', `${FID_B}.png`, true),
    entry('default', `${FID_C}.pdf`),
  ];
  const tfiles = [tfile(` ${FID_A.toLowerCase()} `, 'Default'), tfile(FID_C, 'tenant-a', ['application', 'pdf', 'pdf'])];
  return { entries, tfiles, byPath: (path: string) => entries.find((found) => found.path === path) as ManifestEntry };
}

describe('planObjects', () => {
  it('plans each manifest object in manifest order with its tenant, key, content type and status', async () => {
    const { entries, tfiles, byPath } = twoSites();
    const { ctx, queries, statements } = store(entries, tfiles);

    const plan = await planObjects(ctx, 5);

    const defaultTenant = tenantIdForSite('Default');
    const umbrella = tenantIdForSite(UMBRELLA);
    const tenantA = tenantIdForSite('tenant-a');
    expect(plan).toEqual([
      {
        entry: byPath(`default/cache/file/${FID_A}.jpg`),
        tenantId: defaultTenant,
        key: `${defaultTenant}/${FID_A}.jpg`,
        contentType: 'image/jpeg',
        status: 'transfer',
        orphan: false,
      },
      {
        entry: byPath(`default/cache/file/${FID_A}_small.jpg`),
        tenantId: defaultTenant,
        key: `${defaultTenant}/${FID_A}_small.jpg`,
        contentType: 'image/jpeg',
        status: 'transfer',
        orphan: false,
      },
      {
        entry: byPath(`default/cache/file/${FID_B}.png`),
        tenantId: umbrella,
        key: `${umbrella}/${FID_B}.png`,
        contentType: 'application/octet-stream',
        status: 'transfer',
        orphan: true,
      },
      {
        entry: byPath(`default/cache/file/${FID_C}.pdf`),
        tenantId: tenantA,
        key: `${tenantA}/${FID_C}.pdf`,
        contentType: 'application/pdf',
        status: 'misplaced',
        orphan: false,
      },
      {
        entry: byPath(`tenant-a/cache/file/${FID_C}.pdf`),
        tenantId: tenantA,
        key: `${tenantA}/${FID_C}.pdf`,
        contentType: 'application/pdf',
        status: 'transfer',
        orphan: false,
      },
    ]);
    expect(queries).toEqual([
      { database: SNAP_DB, sql: OWNERS_SQL },
      { database: SNAP_DB, sql: TYPES_SQL },
    ]);
    expect(statements.map((statement) => statement.sql)).toEqual(['SELECT database_name FROM migration.snapshot WHERE seq = $1', FIRST_PAGE_SQL]);
  });

  it.each<[string, TfilesRow, string, string]>([
    ['its row type for the row extension', tfile(FID_D, 'default', ['image', 'gif', 'GIF']), `${FID_D}_medium.gif`, 'image/gif'],
    ['image/jpeg for the jpg rendition of an FLV', tfile(FID_D, 'default', ['video', 'x-flv', 'flv']), `${FID_D}.jpg`, 'image/jpeg'],
    ['octet-stream for another rendition of an FLV', tfile(FID_D, 'default', ['video', 'x-flv', 'flv']), `${FID_D}.png`, 'application/octet-stream'],
    ['octet-stream for another extension than the row', tfile(FID_D, 'default', ['image', 'jpeg', 'jpg']), `${FID_D}.png`, 'application/octet-stream'],
    ['octet-stream for a row without a subtype', tfile(FID_D, 'default', ['image', null, 'jpg']), `${FID_D}.jpg`, 'application/octet-stream'],
    ['octet-stream for a row without an extension', tfile(FID_D, 'default', ['image', 'jpeg', null]), `${FID_D}.jpg`, 'application/octet-stream'],
  ])('gives an object %s', async (_case, row, name, contentType) => {
    const { ctx } = store([entry('default', name)], [row]);

    expect((await planObjects(ctx, 5)).map((planned) => planned.contentType)).toEqual([contentType]);
  });

  it('keeps only the requested keys, in manifest order, and reads the database it is given', async () => {
    const { entries, tfiles } = twoSites();
    const { ctx, queries, statements } = store(entries, tfiles);
    const only = [
      { siteId: 'tenant-a', path: `tenant-a/cache/file/${FID_C}.pdf` },
      { siteId: 'default', path: `default/cache/file/${FID_B}.png` },
      { siteId: 'default', path: `default/cache/file/${FID_D}.png` },
    ];

    const plan = await planObjects(ctx, 5, { only, database: 'muradb_restore' });

    expect(plan.map((planned) => keyOf(planned.entry))).toEqual([only[1], only[0]]);
    expect(queries.map((query) => query.database)).toEqual(['muradb_restore', 'muradb_restore']);
    expect(statements.map((statement) => statement.sql)).toEqual([FIRST_PAGE_SQL]);
  });

  it('throws for an unknown snapshot', async () => {
    const { ctx } = store([], []);

    await expect(planObjects(ctx, 6)).rejects.toThrow(new Error('unknown snapshot 6'));
  });
});

describe('transferFiles', () => {
  it('sends each transfer object site after site, logging each site and skipping misplaced copies', async () => {
    const { entries, tfiles, byPath } = twoSites();
    const defaultTenant = tenantIdForSite('Default');
    const { ctx, putObject, filesGet, info } = store(entries, tfiles, { held: [`${defaultTenant}/${FID_A}_small.jpg`] });

    const result = await transferFiles(ctx, 5);

    const sent = [`default/cache/file/${FID_A}.jpg`, `default/cache/file/${FID_A}_small.jpg`, `default/cache/file/${FID_B}.png`, `tenant-a/cache/file/${FID_C}.pdf`];
    expect(result).toEqual({
      snapshotSeq: 5,
      transferred: 3,
      unchanged: 1,
      bytes: sent.reduce((total, path) => total + contentOf(path).byteLength, 0),
      orphans: [{ siteId: 'default', path: `default/cache/file/${FID_B}.png` }],
      misplaced: [{ siteId: 'default', path: `default/cache/file/${FID_C}.pdf` }],
    });
    expect(filesGet.mock.calls.map(([siteId, name]) => `${siteId}/cache/file/${name}`)).toEqual(sent);
    expect(putObject.mock.calls.map(([params, bytes]) => [params, Buffer.from(bytes).toString()])).toEqual(
      sent.map((path) => {
        const found = byPath(path);
        const tenantId = tenantIdForSite(found.orphan ? UMBRELLA : found.siteId === 'tenant-a' ? 'tenant-a' : 'Default');
        const contentType = found.ext === 'jpg' ? 'image/jpeg' : found.ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
        return [
          { tenantId, fileId: found.fileId, variant: found.variant, ext: found.ext, contentType, sha256: found.sha256 },
          contentOf(path).toString(),
        ];
      }),
    );
    expect(info.mock.calls).toEqual([
      ['files of snapshot 5 site default transferred: 2 stored, 1 unchanged'],
      ['files of snapshot 5 site tenant-a transferred: 1 stored, 0 unchanged'],
    ]);
  });

  it('streams the manifest in pages of MANIFEST_PAGE_ROWS, sending objects before the next page is read', async () => {
    const sites = ['a', 'b', 'c'];
    const ids = Array.from({ length: 2345 }, (_unused, index) => `${String(index).padStart(8, '0')}-E5F6-A7B8-C9D0E1F2A3B4C5D6`);
    const entries = ids.map((id, index) => entry(sites[index % 3] ?? 'a', `${id}.txt`));
    const tfiles = ids.map((id, index) => tfile(id, sites[index % 3] ?? 'a', ['text', 'plain', 'txt']));
    const { ctx, events, statements, queries, putObject, info } = store(entries, tfiles);

    const result = await transferFiles(ctx, 5);

    expect(result).toMatchObject({ transferred: 2345, unchanged: 0, orphans: [], misplaced: [] });
    expect(MANIFEST_PAGE_ROWS).toBe(1000);
    const pages = statements.filter((statement) => statement.sql !== 'SELECT database_name FROM migration.snapshot WHERE seq = $1');
    expect(pages.map((page) => page.returned)).toEqual([1000, 1000, 345]);
    expect(Math.max(...statements.map((statement) => statement.returned))).toBeLessThanOrEqual(MANIFEST_PAGE_ROWS);
    expect(events.indexOf('get a/cache/file/00000000-E5F6-A7B8-C9D0E1F2A3B4C5D6.txt')).toBe(1);
    expect(events.filter((event) => event === 'page').length).toBe(3);
    expect(events.indexOf('page', 1)).toBe(1001);
    expect(queries).toHaveLength(2);
    expect(putObject.mock.calls.map(([params]) => params.fileId)).toEqual(entries.toSorted(keyOrder).map((found) => found.fileId));
    expect(info.mock.calls).toEqual([
      ['files of snapshot 5 site a transferred: 782 stored, 0 unchanged'],
      ['files of snapshot 5 site b transferred: 782 stored, 0 unchanged'],
      ['files of snapshot 5 site c transferred: 781 stored, 0 unchanged'],
    ]);
  });

  it.each<[string, PlanOptions, string[], string[]]>([
    [
      'the requested keys of one site',
      { only: [{ siteId: 'tenant-a', path: `tenant-a/cache/file/${FID_C}.pdf` }] },
      [`tenant-a/cache/file/${FID_C}.pdf`],
      ['files of snapshot 5 site tenant-a transferred: 1 stored, 0 unchanged'],
    ],
    [
      'a requested misplaced copy, logging its site',
      { only: [{ siteId: 'default', path: `default/cache/file/${FID_C}.pdf` }] },
      [],
      ['files of snapshot 5 site default transferred: 0 stored, 0 unchanged'],
    ],
    ['nothing for an empty request', { only: [] }, [], []],
  ])('sends only %s', async (_case, opts, sent, logs) => {
    const { entries, tfiles } = twoSites();
    const { ctx, filesGet, info } = store(entries, tfiles);

    const result = await transferFiles(ctx, 5, opts);

    expect(filesGet.mock.calls.map(([siteId, name]) => `${siteId}/cache/file/${name}`)).toEqual(sent);
    expect(result.transferred).toBe(sent.length);
    expect(info.mock.calls).toEqual(logs.map((line) => [line]));
  });

  it.each<[string, (found: ManifestEntry) => LegacyFileBytes | Error, (found: ManifestEntry) => string]>([
    ['the bridge finds bytes that differ from its header', (found) => new BridgeHashMismatchError('files.get', 200, found.sha256, sha('other')), () => sha('other')],
    ['the bridge header differs from the manifest', (found) => new BridgeHashMismatchError('files.get', 200, sha('header'), found.sha256), () => sha('header')],
    ['the bytes differ from the manifest', () => ({ bytes: Buffer.from('changed'), sha256: sha('changed') }), () => sha('changed')],
    ['only the header differs from the manifest', (found) => ({ bytes: contentOf(found.path), sha256: sha('header').toUpperCase() }), () => sha('header')],
    ['the header is missing', (found) => ({ bytes: contentOf(found.path), sha256: '' }), () => ''],
  ])('stops with FileHashMismatchError before sending an object when %s', async (_case, answer, actual) => {
    const { entries, tfiles, byPath } = twoSites();
    const mismatched = byPath(`default/cache/file/${FID_B}.png`);
    const { ctx, putObject, info } = store(entries, tfiles, { answers: { [mismatched.path]: answer(mismatched) } });

    const error = await transferFiles(ctx, 5).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileHashMismatchError);
    expect(error).toMatchObject({
      name: 'FileHashMismatchError',
      siteId: 'default',
      path: mismatched.path,
      expected: mismatched.sha256,
      actual: actual(mismatched),
      message: `Legacy file ${mismatched.path} of site default hashes to ${actual(mismatched) || '(none)'}, not the manifest's ${mismatched.sha256}`,
    });
    expect(putObject.mock.calls.map(([params]) => `${params.fileId}${params.variant}`)).toEqual([FID_A, `${FID_A}_small`]);
    expect(info).not.toHaveBeenCalled();
  });

  it('propagates any other bridge failure unchanged', async () => {
    const { entries, tfiles } = twoSites();
    const failure = new BridgeError('files.get', 404, '');
    const { ctx, putObject } = store(entries, tfiles, { answers: { [`tenant-a/cache/file/${FID_C}.pdf`]: failure } });

    await expect(transferFiles(ctx, 5)).rejects.toBe(failure);
    expect(putObject).toHaveBeenCalledTimes(3);
  });
});
