// Unit tests for moving file-store objects to strategies-content: planning, paged streaming, per-site logs, hash checks and removal.
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';

import type { Logger } from '@opt2/platform/logging';
import { tenantIdForSite, type MetadataTx, type QueryResult, type QueryResultRow, type TenantDb } from '@opt2/platform/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationContext } from '../../src/context.js';
import { streamChangedEntries } from '../../src/files/feed.js';
import { FILE_LOOKUP_IDS, MANIFEST_PAGE_ROWS, type ManifestEntry, type ManifestKey } from '../../src/files/manifest.js';
import type { StoredVariant } from '../../src/files/names.js';
import { FileHashMismatchError, planObjects, removeDroppedObjects, transferFiles, type PlanOptions } from '../../src/files/transfer.js';
import { BridgeError, BridgeHashMismatchError, type BridgeClient, type LegacyFileDownload } from '../../src/legacy/bridge.js';
import type { LegacyDb } from '../../src/legacy/legacy-db.js';
import { OwnerCallError, type ObjectBody, type OwnersClient, type PutObjectParams } from '../../src/owners/client.js';
import { compareObjects } from '../../src/reconcile/compare.js';
import { readLegacyObjects } from '../../src/reconcile/legacy-side.js';

const SNAP_DB = 'muradb_opt2_snap_5';
const PREV_DB = 'muradb_opt2_snap_4';
const SNAPSHOT_DATABASES: Record<number, string> = { 4: PREV_DB, 5: SNAP_DB };
const FID_A = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_B = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_C = 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_D = 'D1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_E = 'E1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const SELECT_MANIFEST = 'SELECT site_id, path, file_id, variant, ext, size, sha256, orphan FROM migration.file_manifest';
const MANIFEST_ORDER = 'ORDER BY site_id COLLATE "C", path COLLATE "C"';
const FIRST_PAGE_SQL = `${SELECT_MANIFEST} WHERE snapshot_seq = $1 ${MANIFEST_ORDER} LIMIT $2`;
const NEXT_PAGE_SQL = `${SELECT_MANIFEST} WHERE snapshot_seq = $1 AND (site_id COLLATE "C", path COLLATE "C") > ($2, $3) ${MANIFEST_ORDER} LIMIT $4`;
const NAMES_SQL =
  `${SELECT_MANIFEST} WHERE snapshot_seq = $1 AND file_id = ANY($2::bpchar[]) ` +
  `AND (file_id, variant, ext) IN (SELECT * FROM unnest($2::bpchar[], $3::text[], $4::text[])) ${MANIFEST_ORDER}`;
const UMBRELLA = 'umbrella';

/** Identity of a (file id, variant, extension) triple. */
const nameText = (fileId: string, variant: string, ext: string): string => `${fileId}\u0000${variant}\u0000${ext}`;

/** Triples a names lookup binds as its three parallel arrays after the snapshot. */
function boundNames(values: unknown[]): Set<string> {
  const [ids, variants, exts] = values.slice(1) as [string[], string[], string[]];
  if (variants.length !== ids.length || exts.length !== ids.length) throw new Error('names lookup binds arrays of unequal lengths');
  return new Set(ids.map((id, index) => nameText(id, variants[index] ?? '', exts[index] ?? '')));
}

/** The tfiles lookup of `count` file ids, bound `@p0` onwards. */
function lookupSql(count: number): string {
  const params = Array.from({ length: count }, (_unused, index) => `@p${String(index)}`).join(', ');
  return `SELECT [fileID], [siteID], [contentType], [contentSubType], [fileExt] FROM [dbo].[tfiles] WHERE [fileID] IN (${params});`;
}

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const contentOf = (path: string): Buffer => Buffer.from(`bytes of ${path}`);
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const keyOrder = (a: ManifestKey, b: ManifestKey): number => byteOrder(a.siteId, b.siteId) || byteOrder(a.path, b.path);
const keyOf = ({ siteId, path }: ManifestEntry): ManifestKey => ({ siteId, path });

/** Manifest entry of `<siteId>/cache/file/<name>` in snapshot `snapshotSeq`, hashed over contentOf its path. */
function entry(siteId: string, name: string, orphan = false, snapshotSeq = 5): ManifestEntry {
  const dot = name.lastIndexOf('.');
  const path = `${siteId}/cache/file/${name}`;
  const bytes = contentOf(path);
  return {
    snapshotSeq,
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

/** Migration database of snapshots 4 and 5, their manifests answered in keyset pages; `events` records page reads. */
function migrationDb(entries: readonly ManifestEntry[], events: string[]) {
  const statements: { sql: string; values: unknown[]; returned: number }[] = [];
  const sorted = entries.toSorted(keyOrder);
  const answer = (sql: string, values: unknown[]): QueryResultRow[] => {
    if (sql === 'SELECT database_name FROM migration.snapshot WHERE seq = $1') {
      const database = SNAPSHOT_DATABASES[values[0] as number];
      return database === undefined ? [] : [{ database_name: database }];
    }
    if (sql === 'SELECT state, manifest_complete FROM migration.snapshot WHERE seq = $1') {
      return SNAPSHOT_DATABASES[values[0] as number] === undefined ? [] : [{ state: 'ready', manifest_complete: true }];
    }
    if (sql !== FIRST_PAGE_SQL && sql !== NEXT_PAGE_SQL && sql !== NAMES_SQL) throw new Error(`unexpected statement: ${sql}`);
    const after = sql === NEXT_PAGE_SQL ? { siteId: values[1] as string, path: values[2] as string } : undefined;
    const limit = sql === NAMES_SQL ? Infinity : (values[sql === NEXT_PAGE_SQL ? 3 : 1] as number);
    const names = sql === NAMES_SQL ? boundNames(values) : undefined;
    events.push(sql === NAMES_SQL ? 'names' : 'page');
    return sorted
      .filter(
        (found) =>
          found.snapshotSeq === values[0] &&
          (after === undefined || keyOrder(found, after) > 0) &&
          (names?.has(nameText(found.fileId, found.variant, found.ext)) ?? true),
      )
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

/** Legacy SQL Server whose restored databases each hold `tfiles` rows; `queries` records each lookup with its bound ids. */
function legacyOf(databases: Record<string, TfilesRow[]>) {
  const queries: { database: string; sql: string; inputs: unknown[] }[] = [];
  const database = vi.fn((name: string) => {
    const rows = databases[name];
    if (rows === undefined) return Promise.reject(new Error(`Cannot open database "${name}"`));
    const request = () => {
      const inputs: unknown[] = [];
      const bound = {
        input: (_name: string, _type: unknown, value: unknown) => {
          inputs.push(value);
          return bound;
        },
        query: (sql: string) => {
          queries.push({ database: name, sql, inputs });
          if (sql !== lookupSql(inputs.length)) return Promise.reject(new Error(`unexpected legacy statement: ${sql}`));
          // The legacy collation compares char(35) ids case-insensitively and without trailing spaces.
          const wanted = new Set(inputs.map((value) => String(value).trim().toUpperCase()));
          return Promise.resolve({ recordset: rows.filter((row) => wanted.has(row.fileID.trim().toUpperCase())) });
        },
      };
      return bound;
    };
    return Promise.resolve({ request });
  });
  return { legacy: { database } as unknown as LegacyDb, queries };
}

/**
 * Bridge writing each path's contentOf bytes, or the bytes `answers` gives it, to the sink, or failing with the error
 * `answers` gives it; `spools` records the temporary directory's entries at each read.
 */
function bridgeOf(events: string[], answers: Record<string, Buffer | Error> = {}) {
  const spools: string[][] = [];
  const filesGet = vi.fn(async (siteId: string, name: string, sink: Writable): Promise<LegacyFileDownload> => {
    const path = `${siteId}/cache/file/${name}`;
    events.push(`get ${path}`);
    spools.push(await readdir(tmpdir()));
    const answer = answers[path];
    if (answer instanceof Error) throw answer;
    const bytes = answer ?? contentOf(path);
    await pipeline(Readable.from([bytes]), sink);
    return { sha256: sha(bytes), size: bytes.byteLength };
  });
  return { bridge: { filesGet } as unknown as BridgeClient, filesGet, spools };
}

/**
 * strategies-content upload and deletion over the size and SHA-256 it stores per key, already holding the `held` keys;
 * an upload whose key `refusals` names fails with that error. `uploads` holds each streamed body read to its end with its
 * declared size.
 */
function ownersOf(held: readonly string[] = [], refusals: Record<string, Error> = {}) {
  const stored = new Map(held.map((key) => [key, { size: 0, sha256: '' }]));
  const uploads: { params: PutObjectParams; bytes: Buffer; size: number }[] = [];
  const putObject = vi.fn(async (params: PutObjectParams, body: ObjectBody) => {
    const key = `${params.tenantId}/${params.fileId}${params.variant}.${params.ext}`;
    if (body instanceof Uint8Array) throw new Error('the transfer sends a stream');
    const bytes = await buffer(body.stream);
    uploads.push({ params, bytes, size: body.size });
    const refusal = refusals[key];
    if (refusal !== undefined) throw refusal;
    const created = !stored.has(key);
    stored.set(key, { size: bytes.byteLength, sha256: params.sha256 });
    return { key, size: bytes.byteLength, sha256: params.sha256, created, writePositions: {} };
  });
  const deleteObject = vi.fn((key: string) => Promise.resolve({ key, deleted: stored.delete(key), writePositions: new Map() }));
  return { owners: { putObject, deleteObject } as unknown as OwnersClient, putObject, deleteObject, stored, uploads };
}

/** Transfer context over `entries`, the `tfiles` rows of snapshot 5 and optionally of snapshot 4, and optional bridge answers. */
function store(
  entries: readonly ManifestEntry[],
  tfiles: TfilesRow[],
  opts: { held?: string[]; answers?: Record<string, Buffer | Error>; previous?: TfilesRow[]; refusals?: Record<string, Error> } = {},
) {
  const events: string[] = [];
  const db = migrationDb(entries, events);
  const legacy = legacyOf({ [SNAP_DB]: tfiles, muradb_restore: tfiles, ...(opts.previous === undefined ? {} : { [PREV_DB]: opts.previous }) });
  const bridge = bridgeOf(events, opts.answers);
  const owners = ownersOf(opts.held, opts.refusals);
  const info = vi.fn();
  const warn = vi.fn();
  const config = { umbrellaSiteId: UMBRELLA, fileStore: { flvRenditionExt: 'jpg' } } as unknown as MigrationContext['config'];
  const ctx = { db: db.db, legacy: legacy.legacy, bridge: bridge.bridge, owners: owners.owners, logger: { info, warn } as unknown as Logger, config };
  return {
    ctx,
    events,
    statements: db.statements,
    queries: legacy.queries,
    filesGet: bridge.filesGet,
    spools: bridge.spools,
    putObject: owners.putObject,
    uploads: owners.uploads,
    deleteObject: owners.deleteObject,
    stored: owners.stored,
    info,
    warn,
  };
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
    expect(queries).toEqual([{ database: SNAP_DB, sql: lookupSql(3), inputs: [FID_A, FID_B, FID_C] }]);
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

  it('plans only the entries it is given, in their order, without reading the manifest, against the database it is given', async () => {
    const { entries, tfiles, byPath } = twoSites();
    const { ctx, queries, statements } = store(entries, tfiles);
    const given = [byPath(`default/cache/file/${FID_B}.png`), byPath(`tenant-a/cache/file/${FID_C}.pdf`)];

    const plan = await planObjects(ctx, 5, { entries: given, database: 'muradb_restore' });

    expect(plan.map((planned) => [keyOf(planned.entry), planned.status, planned.orphan])).toEqual([
      [keyOf(given[0] as ManifestEntry), 'transfer', true],
      [keyOf(given[1] as ManifestEntry), 'transfer', false],
    ]);
    expect(queries).toEqual([{ database: 'muradb_restore', sql: lookupSql(2), inputs: [FID_B, FID_C] }]);
    expect(statements).toEqual([]);
  });

  it(`looks tfiles up once per ${String(MANIFEST_PAGE_ROWS)} planned entries with unchanged content types`, async () => {
    const ids = Array.from({ length: MANIFEST_PAGE_ROWS + 5 }, (_unused, index) => `${String(index).padStart(8, '0')}-E5F6-A7B8-C9D0E1F2A3B4C5D6`);
    const entries = ids.map((id) => entry('default', `${id}.pdf`));
    const tfiles = ids.map((id, index) => tfile(id, 'Default', index % 2 === 0 ? ['application', 'pdf', 'pdf'] : ['image', 'png', 'png']));
    const { ctx, queries } = store(entries, tfiles);

    const plan = await planObjects(ctx, 5);

    expect(plan.map((planned) => planned.contentType)).toEqual(ids.map((_id, index) => (index % 2 === 0 ? 'application/pdf' : 'application/octet-stream')));
    expect(queries.map((query) => [query.sql, query.inputs])).toEqual([
      [lookupSql(MANIFEST_PAGE_ROWS), ids.slice(0, MANIFEST_PAGE_ROWS)],
      [lookupSql(5), ids.slice(MANIFEST_PAGE_ROWS)],
    ]);
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
    const { ctx, uploads, filesGet, info } = store(entries, tfiles, { held: [`${defaultTenant}/${FID_A}_small.jpg`] });

    const result = await transferFiles(ctx, 5);

    const sent = [`default/cache/file/${FID_A}.jpg`, `default/cache/file/${FID_A}_small.jpg`, `default/cache/file/${FID_B}.png`, `tenant-a/cache/file/${FID_C}.pdf`];
    expect(result).toEqual({
      snapshotSeq: 5,
      transferred: 3,
      unchanged: 1,
      bytes: sent.reduce((total, path) => total + contentOf(path).byteLength, 0),
      orphans: [{ siteId: 'default', path: `default/cache/file/${FID_B}.png` }],
      misplaced: [{ siteId: 'default', path: `default/cache/file/${FID_C}.pdf` }],
      rejected: [],
    });
    expect(filesGet.mock.calls.map(([siteId, name]) => `${siteId}/cache/file/${name}`)).toEqual(sent);
    // Each upload streams exactly the bytes read, under their byte count as Content-Length.
    expect(uploads.map(({ params, bytes, size }) => [params, bytes.toString(), size])).toEqual(
      sent.map((path) => {
        const found = byPath(path);
        const tenantId = tenantIdForSite(found.orphan ? UMBRELLA : found.siteId === 'tenant-a' ? 'tenant-a' : 'Default');
        const contentType = found.ext === 'jpg' ? 'image/jpeg' : found.ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
        return [
          { tenantId, fileId: found.fileId, variant: found.variant, ext: found.ext, contentType, sha256: found.sha256 },
          contentOf(path).toString(),
          contentOf(path).byteLength,
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

    expect(result).toMatchObject({ transferred: 2345, unchanged: 0, orphans: [], misplaced: [], rejected: [] });
    expect(MANIFEST_PAGE_ROWS).toBe(1000);
    const pages = statements.filter((statement) => statement.sql !== 'SELECT database_name FROM migration.snapshot WHERE seq = $1');
    expect(pages.map((page) => page.returned)).toEqual([1000, 1000, 345]);
    expect(Math.max(...statements.map((statement) => statement.returned))).toBeLessThanOrEqual(MANIFEST_PAGE_ROWS);
    expect(events.indexOf('get a/cache/file/00000000-E5F6-A7B8-C9D0E1F2A3B4C5D6.txt')).toBe(1);
    expect(events.filter((event) => event === 'page').length).toBe(3);
    expect(events.indexOf('page', 1)).toBe(1001);
    expect(queries.map((query) => query.inputs.length)).toEqual([1000, 1000, 345]);
    expect(putObject.mock.calls.map(([params]) => params.fileId)).toEqual(entries.toSorted(keyOrder).map((found) => found.fileId));
    expect(info.mock.calls).toEqual([
      ['files of snapshot 5 site a transferred: 782 stored, 0 unchanged'],
      ['files of snapshot 5 site b transferred: 782 stored, 0 unchanged'],
      ['files of snapshot 5 site c transferred: 781 stored, 0 unchanged'],
    ]);
  });

  it.each<[string, string[], string[], string[]]>([
    [
      'the given entries of one site',
      [`tenant-a/cache/file/${FID_C}.pdf`],
      [`tenant-a/cache/file/${FID_C}.pdf`],
      ['files of snapshot 5 site tenant-a transferred: 1 stored, 0 unchanged'],
    ],
    [
      'a given misplaced copy, logging its site',
      [`default/cache/file/${FID_C}.pdf`],
      [],
      ['files of snapshot 5 site default transferred: 0 stored, 0 unchanged'],
    ],
    ['nothing for no entries', [], [], []],
  ])('sends only %s', async (_case, given, sent, logs) => {
    const { entries, tfiles, byPath } = twoSites();
    const { ctx, filesGet, info } = store(entries, tfiles);
    const opts: PlanOptions = { entries: given.map(byPath) };

    const result = await transferFiles(ctx, 5, opts);

    expect(filesGet.mock.calls.map(([siteId, name]) => `${siteId}/cache/file/${name}`)).toEqual(sent);
    expect(result.transferred).toBe(sent.length);
    expect(info.mock.calls).toEqual(logs.map((line) => [line]));
  });

  it.each<[string, (found: ManifestEntry) => Buffer | Error, (found: ManifestEntry) => string]>([
    ['the bridge finds bytes that differ from its header', (found) => new BridgeHashMismatchError('files.get', 200, found.sha256, sha('other')), () => sha('other')],
    ['the bridge header differs from the manifest', (found) => new BridgeHashMismatchError('files.get', 200, sha('header'), found.sha256), () => sha('header')],
    ['the bridge header is missing', (found) => new BridgeHashMismatchError('files.get', 200, '', found.sha256), () => ''],
    ['the bytes differ from the manifest', () => Buffer.from('changed'), () => sha('changed')],
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

  const umbrellaKey = `${tenantIdForSite(UMBRELLA)}/${FID_B}.png`;
  const refused = (status: number, body: unknown) =>
    new OwnerCallError('strategies-content', 'POST', '/internal/v1/migration/objects', status, body);

  it.each<[string, OwnerCallError, string]>([
    [
      'a 400 naming its error',
      refused(400, { apiversion: 'v1', method: 'undefined', params: {}, error: { message: 'Invalid parameters', code: 'invalid_request' } }),
      'invalid_request: Invalid parameters',
    ],
    ['a 413 without an error envelope', refused(413, '<html>Post Size</html>'), 'Owner strategies-content answered POST /internal/v1/migration/objects with HTTP 413'],
  ])('records an object the owner refuses with %s and sends the rest', async (_case, refusal, error) => {
    const { entries, tfiles } = twoSites();
    const { ctx, putObject, info, warn } = store(entries, tfiles, { refusals: { [umbrellaKey]: refusal } });

    const result = await transferFiles(ctx, 5);

    expect(result).toMatchObject({
      transferred: 3,
      unchanged: 0,
      rejected: [{ siteId: 'default', path: `default/cache/file/${FID_B}.png`, key: umbrellaKey, status: refusal.status, error }],
    });
    expect(putObject).toHaveBeenCalledTimes(4);
    expect(info.mock.calls).toEqual([
      ['files of snapshot 5 site default transferred: 2 stored, 0 unchanged, 1 refused by the owner'],
      ['files of snapshot 5 site tenant-a transferred: 1 stored, 0 unchanged'],
    ]);
    expect(warn.mock.calls).toEqual([['files of snapshot 5: strategies-content refused 1 objects, which stay untransferred']]);
  });

  it.each([401, 403, 500, 503])('stops on an owner answer of HTTP %i, which no single object causes', async (status) => {
    const { entries, tfiles } = twoSites();
    const failure = refused(status, {});
    const { ctx, putObject, warn } = store(entries, tfiles, { refusals: { [umbrellaKey]: failure } });

    await expect(transferFiles(ctx, 5)).rejects.toBe(failure);
    expect(putObject).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('object spool', () => {
    const changed = `default/cache/file/${FID_B}.png`;
    let spoolParent: string;

    beforeEach(async () => {
      spoolParent = await mkdtemp(join(tmpdir(), 'files-transfer-spool-'));
      vi.stubEnv('TMPDIR', spoolParent);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(spoolParent, { recursive: true, force: true });
    });

    it.each<[string, Parameters<typeof store>[2], (run: Promise<unknown>) => Promise<unknown>]>([
      ['every object is stored', {}, (run) => expect(run).resolves.toMatchObject({ transferred: 4, rejected: [] })],
      ['the bytes differ from the manifest', { answers: { [changed]: Buffer.from('changed') } }, (run) => expect(run).rejects.toBeInstanceOf(FileHashMismatchError)],
      ['the bridge fails', { answers: { [changed]: new BridgeError('files.get', 404, '') } }, (run) => expect(run).rejects.toBeInstanceOf(BridgeError)],
      ['the owner refuses one object', { refusals: { [umbrellaKey]: refused(400, {}) } }, (run) => expect(run).resolves.toMatchObject({ transferred: 3, rejected: [{ key: umbrellaKey }] })],
      ['the owner fails', { refusals: { [umbrellaKey]: refused(503, {}) } }, (run) => expect(run).rejects.toBeInstanceOf(OwnerCallError)],
    ])('holds one object on disk at a time and leaves no spool behind when %s', async (_case, opts, settles) => {
      const { entries, tfiles } = twoSites();
      const { ctx, spools } = store(entries, tfiles, opts);

      await settles(transferFiles(ctx, 5));

      expect(spools.length).toBeGreaterThan(0);
      for (const listed of spools) expect(listed).toEqual([expect.stringMatching(/^opt2-file-spool-/)]);
      expect(await readdir(spoolParent)).toEqual([]);
    });
  });

});

describe('removeDroppedObjects', () => {
  const defaultTenant = tenantIdForSite('Default');
  const umbrella = tenantIdForSite(UMBRELLA);
  const tenantA = tenantIdForSite('tenant-a');
  const reuploaded = Buffer.from('re-uploaded pdf');

  /**
   * Snapshot 4 and the feed snapshot 5. Removed at 5: a rendition, an orphan whose umbrella key an orphan copy of another site
   * still plans, and a misplaced copy. Changed at 5: an orphan that gained its row, so its key leaves the umbrella tenant, and a
   * re-uploaded PDF keeping its key.
   */
  function twoSnapshots() {
    const before = [
      entry('default', `${FID_A}.jpg`, false, 4),
      entry('default', `${FID_A}_small.jpg`, false, 4),
      entry('default', `${FID_B}.png`, true, 4),
      entry('default', `${FID_C}.pdf`, false, 4),
      entry('default', `${FID_D}.png`, true, 4),
      entry('tenant-a', `${FID_C}.pdf`, false, 4),
      entry('tenant-a', `${FID_E}.pdf`, false, 4),
    ];
    const after = [
      entry('default', `${FID_A}.jpg`),
      entry('default', `${FID_D}.png`),
      entry('tenant-a', `${FID_B}.png`, true),
      entry('tenant-a', `${FID_C}.pdf`),
      { ...entry('tenant-a', `${FID_E}.pdf`), size: reuploaded.byteLength, sha256: sha(reuploaded) },
    ];
    const pdf: [string, string, string] = ['application', 'pdf', 'pdf'];
    const previous = [tfile(FID_A, 'Default'), tfile(FID_C, 'tenant-a', pdf), tfile(FID_E, 'tenant-a', pdf)];
    const tfiles = [...previous, tfile(FID_D, 'Default', ['image', 'png', 'png'])];
    const answers: Record<string, Buffer> = {};
    const fixture = store([...before, ...after], tfiles, { previous, answers });
    return { ...fixture, answers };
  }

  const diff = { from: 4, to: 5 };

  /** Backfills snapshot 4, then transfers the objects snapshot 5 added or changed. */
  async function transferToFive(fixture: ReturnType<typeof twoSnapshots>) {
    await transferFiles(fixture.ctx, 4);
    fixture.answers[`tenant-a/cache/file/${FID_E}.pdf`] = reuploaded;
    await transferFiles(fixture.ctx, 5, { entries: streamChangedEntries(fixture.ctx, 4, 5) });
    fixture.info.mockClear();
    fixture.queries.length = 0;
  }

  /** Feeds snapshot 5 after the backfill of 4: the diff's transfer, then its removal. */
  async function feed(fixture: ReturnType<typeof twoSnapshots>) {
    await transferToFive(fixture);
    return { removal: await removeDroppedObjects(fixture.ctx, diff) };
  }

  /** The after-feed object comparison of snapshot 5's legacy manifest with the objects the owner holds. */
  async function reconcileObjects(fixture: ReturnType<typeof twoSnapshots>) {
    const legacy = await readLegacyObjects(fixture.ctx, { legacySource: 'snapshot', snapshotSeq: 5, database: SNAP_DB });
    if (legacy.status !== 'compared') throw new Error(`snapshot 5 objects ${legacy.status}: ${legacy.reason}`);
    return compareObjects(
      [...legacy.byTenant.values()].flat(),
      [...fixture.stored].map(([key, object]) => ({ key, ...object })),
    );
  }

  it('deletes the keys snapshot 4 placed for dropped copies that snapshot 5 no longer plans, leaving still-planned and misplaced ones', async () => {
    const fixture = twoSnapshots();

    const { removal } = await feed(fixture);

    expect(removal).toEqual({ from: 4, to: 5, deleted: 2, absent: 0, retained: 2, misplaced: 1 });
    expect(fixture.deleteObject.mock.calls).toEqual([[`${defaultTenant}/${FID_A}_small.jpg`], [`${umbrella}/${FID_D}.png`]]);
    expect([...fixture.stored.keys()]).toEqual(expect.arrayContaining([`${umbrella}/${FID_B}.png`, `${tenantA}/${FID_C}.pdf`, `${defaultTenant}/${FID_D}.png`]));
    expect(fixture.info.mock.calls).toEqual([['files of snapshot 5 dropped since snapshot 4: 2 deleted, 0 already absent, 2 still planned, 1 misplaced']]);
    // One batch: the copies of both snapshots under the dropped names, and one tfiles lookup per snapshot database.
    const dropped = [[FID_A, FID_B, FID_C, FID_D, FID_E], ['_small', '', '', '', ''], ['jpg', 'png', 'pdf', 'png', 'pdf']];
    expect(fixture.statements.filter((statement) => statement.sql === NAMES_SQL).map((statement) => statement.values)).toEqual([
      [4, ...dropped],
      [5, ...dropped],
    ]);
    expect(fixture.queries.map((query) => query.database).sort()).toEqual([PREV_DB, SNAP_DB]);
  });

  it('brings the after-feed object reconciliation from the dropped objects to zero difference, and answers a repeat as absent', async () => {
    const fixture = twoSnapshots();
    await transferToFive(fixture);
    expect(await reconcileObjects(fixture)).toMatchObject({
      differenceCount: 2,
      differences: expect.arrayContaining([
        expect.objectContaining({ kind: 'object-extra-in-target', key: `${defaultTenant}/${FID_A}_small.jpg` }),
        expect.objectContaining({ kind: 'object-extra-in-target', key: `${umbrella}/${FID_D}.png` }),
      ]),
    });

    await removeDroppedObjects(fixture.ctx, diff);
    const zero = { legacyObjects: 5, targetObjects: 5, differenceCount: 0, differences: [] };
    expect(await reconcileObjects(fixture)).toMatchObject(zero);

    const repeat = await removeDroppedObjects(fixture.ctx, diff);
    expect(repeat).toEqual({ from: 4, to: 5, deleted: 0, absent: 2, retained: 2, misplaced: 1 });
    expect(await reconcileObjects(fixture)).toMatchObject(zero);
  });

  it('reads only the two manifests and deletes nothing when no copy was removed or changed', async () => {
    const kept = [entry('default', `${FID_A}.jpg`, false, 4), entry('default', `${FID_A}.jpg`)];
    const { ctx, queries, statements, deleteObject, info } = store(kept, [tfile(FID_A, 'Default')]);

    const removal = await removeDroppedObjects(ctx, diff);

    expect(removal).toEqual({ from: 4, to: 5, deleted: 0, absent: 0, retained: 0, misplaced: 0 });
    expect(statements.map((statement) => [statement.sql, statement.values[0]])).toEqual([
      [FIRST_PAGE_SQL, 4],
      [FIRST_PAGE_SQL, 5],
    ]);
    expect([queries, deleteObject.mock.calls, info.mock.calls]).toEqual([[], [], []]);
  });

  /**
   * Snapshots 4 and 5 whose dropped copies span three batches: the umbrella key of an orphan dropped from sites `a` and `z`,
   * whose copies fall in the first and last batch; a changed copy whose key snapshot 5 still plans; misplaced copies; and
   * filler renditions, each its own key.
   */
  function manyBatches() {
    const filler = Array.from({ length: MANIFEST_PAGE_ROWS * 2 }, (_unused, index) => `${String(index).padStart(8, '0')}-E5F6-A7B8-C9D0E1F2A3B4C5D6`);
    const changed = { ...entry('m', `${FID_E}.pdf`), size: reuploaded.byteLength, sha256: sha(reuploaded) };
    const before = [
      entry('a', `${FID_B}.png`, true, 4),
      ...filler.map((id) => entry('m', `${id}.txt`, false, 4)),
      entry('m', `${FID_C}.pdf`, false, 4),
      entry('m', `${FID_E}.pdf`, false, 4),
      entry('z', `${FID_B}.png`, true, 4),
      entry('z', `${FID_C}.pdf`, false, 4),
    ];
    const after = [entry('m', `${FID_C}.pdf`), changed];
    const rows = [tfile(FID_C, 'm', ['application', 'pdf', 'pdf']), tfile(FID_E, 'm', ['application', 'pdf', 'pdf']), ...filler.map((id) => tfile(id, 'm', ['text', 'plain', 'txt']))];
    const fixture = store([...before, ...after], rows, { previous: rows });
    const m = tenantIdForSite('m');
    return { fixture, filler, m };
  }

  it('decides each dropped key once across batches, keeping the keys snapshot 5 still plans and counting misplaced copies', async () => {
    const { fixture, filler, m } = manyBatches();
    await transferFiles(fixture.ctx, 4);

    const removal = await removeDroppedObjects(fixture.ctx, diff);

    expect(removal).toEqual({ from: 4, to: 5, deleted: filler.length + 1, absent: 0, retained: 1, misplaced: 1 });
    expect(fixture.deleteObject.mock.calls.map(([key]) => key)).toEqual([`${umbrella}/${FID_B}.png`, ...filler.map((id) => `${m}/${id}.txt`)]);
    expect(fixture.deleteObject.mock.calls.map(([key]) => key)).not.toContain(`${m}/${FID_E}.pdf`);
    const lookups = fixture.statements.filter((statement) => statement.sql === NAMES_SQL);
    expect(lookups.map((statement) => statement.values[0])).toEqual([4, 5, 4, 5, 4, 5]);
    expect(Math.max(...lookups.map((statement) => (statement.values[1] as string[]).length))).toBeLessThanOrEqual(MANIFEST_PAGE_ROWS);
    expect(Math.max(...fixture.queries.map((query) => query.inputs.length))).toBeLessThanOrEqual(MANIFEST_PAGE_ROWS);
  });

  /**
   * Snapshots 4 and 5 of one file id with `count` renditions in its row's site `default` and misplaced copies of each in
   * `tenant-a`; snapshot 5 keeps only the first rendition of `default`, re-uploaded, so its key stays planned.
   */
  function oneFileManyRenditions(count: number) {
    const sites = ['default', 'tenant-a'];
    const names = Array.from({ length: count }, (_unused, index) => `${FID_A}_W${String(index)}_H50.jpg`);
    const before = sites.flatMap((siteId) => names.map((name) => entry(siteId, name, false, 4)));
    const after = [{ ...entry('default', names[0] ?? ''), size: reuploaded.byteLength, sha256: sha(reuploaded) }];
    const keys = names.map((name) => `${defaultTenant}/${name}`);
    const rows = [tfile(FID_A, 'Default')];
    return { fixture: store([...before, ...after], rows, { previous: rows, held: keys }), keys, sites: sites.length };
  }

  it('bounds each copy lookup by the batch names times the sites, however many renditions one file id has', async () => {
    const count = MANIFEST_PAGE_ROWS * 2 + 1;
    const { fixture, keys, sites } = oneFileManyRenditions(count);

    const removal = await removeDroppedObjects(fixture.ctx, diff);

    expect(removal).toEqual({ from: 4, to: 5, deleted: count - 1, absent: 0, retained: 1, misplaced: count });
    expect(fixture.deleteObject.mock.calls.map(([key]) => key).sort()).toEqual(keys.slice(1).sort());
    const lookups = fixture.statements.filter((statement) => statement.sql === NAMES_SQL);
    const batches = Math.ceil((count * sites) / MANIFEST_PAGE_ROWS);
    expect(lookups.map((statement) => statement.values[0])).toEqual(Array.from({ length: batches }, () => [4, 5]).flat());
    for (const { values, returned } of lookups) {
      const names = (values[1] as string[]).length;
      expect(names).toBeLessThanOrEqual(FILE_LOOKUP_IDS);
      expect(returned).toBeLessThanOrEqual(names * sites);
    }
  });

  it('throws, deleting nothing, when a streamed dropped copy is missing from its snapshot at the names lookup', async () => {
    const fixture = twoSnapshots();
    const gone = `default/cache/file/${FID_A}_small.jpg`;
    const { db } = fixture.ctx;
    const withMetadata = <T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T> =>
      db.withMetadata((tx) => {
        const query = async (sql: string, values: unknown[]) => {
          const found = await tx.query<{ path: string }>(sql, values);
          return sql === NAMES_SQL && values[0] === 4 ? { ...found, rows: found.rows.filter((row) => row.path !== gone) } : found;
        };
        return fn({ ...tx, query } as unknown as MetadataTx);
      });
    fixture.ctx.db = { ...db, withMetadata } as TenantDb;

    await expect(removeDroppedObjects(fixture.ctx, diff)).rejects.toThrow(
      new Error(`manifest of snapshot 4 no longer drops ${gone} of site default against snapshot 5`),
    );
    expect(fixture.deleteObject).not.toHaveBeenCalled();
  });

  it('propagates an owner failure without reporting a removal', async () => {
    const fixture = twoSnapshots();
    const failure = new Error('strategies-content unavailable');
    fixture.deleteObject.mockRejectedValueOnce(failure);

    await expect(feed(fixture)).rejects.toBe(failure);
    expect(fixture.info).not.toHaveBeenCalled();
  });
});
