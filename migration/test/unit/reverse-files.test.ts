// Unit tests for projecting content.file_object changes onto the legacy file store through fake owners and bridge.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { Logger } from '@opt2/platform/logging';
import {
  CanonicalEncodingError,
  encodeKey,
  encodeRow,
  type CanonicalColumn,
  type ChangeOp,
  type ChangeRow,
  type ChangesResponse,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { InvalidStoredNameError, formatStoredName, type StoredVariant } from '../../src/files/index.js';
import { BridgeError, UnsupportedFileStoreError, type BridgeClient, type FileDeleteTarget, type FilePutOptions } from '../../src/legacy/bridge.js';
import { OwnerCallError, type ChangesParams, type OwnersClient } from '../../src/owners/client.js';
import {
  FILE_OBJECT_UNIT,
  FileObjectMismatchError,
  UnknownFileTenantError,
  executeFileOps,
  isFileObjectChange,
  planFileOps,
  type FileOp,
  type FileOpsDeps,
  type FilePutOp,
} from '../../src/reverse/files.js';

const FILE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const OTHER_ID = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const TENANT_A = tenantIdForSite('tenant-a');
const UMBRELLA = tenantIdForSite('umbrella');
const TENANT_SITES = new Map([
  [TENANT_A, 'tenant-a'],
  [UMBRELLA, 'umbrella'],
]);

// content.file_object in its DDL column order (services/strategies-content/db/migrations/0003_files.sql).
const COLUMNS: CanonicalColumn[] = [
  { name: 'tenant_id', type: 's' },
  { name: 'file_id', type: 's' },
  { name: 'variant', type: 's' },
  { name: 'ext', type: 's' },
  { name: 'object_key', type: 's' },
  { name: 'size', type: 'i' },
  { name: 'sha256', type: 's' },
  { name: 'content_type', type: 's' },
  { name: 'orphan', type: 'i' },
  { name: 'created_at', type: 't' },
];

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface StoredObject {
  tenantId: string;
  fileId: string;
  variant: StoredVariant;
  ext: string;
  bytes: Buffer;
}

function objectOf(tenantId: string, fileId: string, variant: StoredVariant, ext: string, text = `bytes of ${fileId}${variant}.${ext}`): StoredObject {
  return { tenantId, fileId, variant, ext, bytes: Buffer.from(text) };
}

const keyOf = (o: StoredObject): string => `${o.tenantId}/${formatStoredName(o)}`;

function rowOf(o: StoredObject): Record<string, unknown> {
  return {
    tenant_id: o.tenantId,
    file_id: o.fileId,
    variant: o.variant,
    ext: o.ext,
    object_key: keyOf(o),
    size: o.bytes.byteLength,
    sha256: sha(o.bytes),
    content_type: 'image/jpeg',
    orphan: false,
    created_at: '2026-06-30 10:00:00.000',
  };
}

let seq = 0;

/** A changelog row of `file_object` the way the content repository writes it. */
function change(op: ChangeOp, before: StoredObject | null, after: StoredObject | null): ChangeRow {
  seq += 1;
  const keyed = (before ?? after) as StoredObject;
  return {
    xid: '900',
    seq: String(seq),
    table: 'file_object',
    op,
    key: encodeKey(COLUMNS, ['object_key'], rowOf(keyed)),
    before: before === null ? null : encodeRow(COLUMNS, rowOf(before)),
    after: after === null ? null : encodeRow(COLUMNS, rowOf(after)),
    columns: COLUMNS.slice(1).map((column) => column.name),
    origin: 'target',
    actorUserId: null,
    actorService: null,
    at: '2026-06-30 10:00:00.000',
    requestId: null,
    operationId: null,
  };
}

const cursorOf = (row: Pick<ChangeRow, 'xid' | 'seq'>): string => `${row.xid}:${row.seq}`;

/** Row `index` of a planned batch. */
function rowAt(rows: readonly ChangeRow[], index: number): ChangeRow {
  const row = rows[index];
  if (row === undefined) throw new Error(`the batch has no row ${String(index)}`);
  return row;
}

function putOf(o: StoredObject, siteId: string, row: ChangeRow): FilePutOp {
  return {
    kind: 'put',
    tenantId: o.tenantId,
    siteId,
    key: keyOf(o),
    name: formatStoredName(o),
    size: o.bytes.byteLength,
    sha256: sha(o.bytes),
    cursor: cursorOf(row),
  };
}

function deleteOf(o: StoredObject, siteId: string): FileOp {
  return { kind: 'delete', tenantId: o.tenantId, siteId, key: keyOf(o), name: formatStoredName(o) };
}

const CONFIG = loadConfig();
const OBJECTS_PATH = '/internal/v1/migration/objects';

/** A change-feed page the fake owner answers for one `after` cursor. */
interface FeedPage {
  rows: ChangeRow[];
  complete: boolean;
}

interface HarnessOptions {
  /** Paths `<siteId>/<name>` the legacy store holds before the batch. */
  store?: string[];
  /** Change-feed pages by `after` cursor; any other cursor reads one complete empty page. */
  feed?: Record<string, FeedPage>;
  batchRows?: number;
}

/**
 * Fake owners serving `objects` by key as two-chunk streams (404 for any other key) and a change feed, a fake bridge
 * store keyed `<siteId>/<name>` that refuses a body not hashing to its X-Opt2-Sha256 as files.cfm does, and a recording logger.
 */
function harness(objects: StoredObject[], opts: HarnessOptions = {}) {
  const files = new Set(opts.store ?? []);
  const puts: Array<{ siteId: string; name: string; bytes: Buffer; sha256: string; size: number | undefined }> = [];
  const consumed: number[] = [];
  const deletes: Array<{ siteId: string; target: FileDeleteTarget }> = [];
  const sources: Readable[] = [];
  const served = new Map(objects.map((o) => [keyOf(o), o.bytes]));
  const getObject = vi.fn((key: string): Promise<Readable> => {
    const bytes = served.get(key);
    if (bytes === undefined) return Promise.reject(new OwnerCallError('strategies-content', 'GET', OBJECTS_PATH, 404, { error: 'notFound' }));
    const source = Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]);
    sources.push(source);
    return Promise.resolve(source);
  });
  const changes = vi.fn((_owner: string, params: ChangesParams): Promise<ChangesResponse> => {
    const page = opts.feed?.[params.after] ?? { rows: [], complete: true };
    const last = page.rows.at(-1);
    return Promise.resolve({
      rows: page.rows.map((row) => ({ ...row, legacy: [] })),
      cursor: last === undefined ? params.after : cursorOf(last),
      horizon: '1000',
      complete: page.complete,
      operations: {},
    });
  });
  const filesPut = vi.fn(async (siteId: string, name: string, body: Buffer | Uint8Array | AsyncIterable<Uint8Array>, sha256: string, putOpts?: FilePutOptions) => {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    } finally {
      consumed.push(Buffer.concat(chunks).byteLength);
    }
    const bytes = Buffer.concat(chunks);
    if (sha(bytes) !== sha256) throw new BridgeError('files.put', 400, { error: 'hashMismatch' });
    puts.push({ siteId, name, bytes, sha256, size: putOpts?.size });
    files.add(`${siteId}/${name}`);
    return { written: true, name, size: bytes.byteLength, sha256, serverTime: '2026-06-30 10:00:00' };
  });
  const filesDelete = vi.fn((siteId: string, target: FileDeleteTarget) => {
    deletes.push({ siteId, target });
    const path = `${siteId}/${'name' in target ? target.name : target.fileId}`;
    const removed = files.delete(path) ? ['name' in target ? target.name : target.fileId] : [];
    return Promise.resolve({ deleted: removed, serverTime: '2026-06-30 10:00:00' });
  });
  const info = vi.fn();
  const deps: FileOpsDeps = {
    owners: { getObject, changes } as unknown as OwnersClient,
    bridge: { filesPut, filesDelete } as unknown as BridgeClient,
    logger: { info } as unknown as Logger,
    config: { ...CONFIG, projection: { ...CONFIG.projection, batchRows: opts.batchRows ?? CONFIG.projection.batchRows } },
  };
  return { deps, puts, consumed, deletes, files, sources, getObject, changes, filesPut, filesDelete, info };
}

describe('isFileObjectChange', () => {
  it.each<[string, string, string, boolean]>([
    ['a file_object row of the content schema', 'file_object', 'content.file_object', true],
    ['another content table', 'file', 'content.file', false],
    ['a file_object table of another schema', 'file_object', 'finance.file_object', false],
    ['a mismatched unit', 'file_object', 'content.file', false],
  ])('answers %s', (_label, table, unit, expected) => {
    expect(isFileObjectChange({ table }, unit)).toBe(expected);
  });

  it('names the manifest table as the ownership file does', () => {
    expect(FILE_OBJECT_UNIT).toBe('content.file_object');
  });
});

describe('planFileOps', () => {
  const small = objectOf(TENANT_A, FILE_ID, '_small', 'jpg');
  const original = objectOf(TENANT_A, FILE_ID, '', 'pdf');

  const renamed = objectOf(TENANT_A, OTHER_ID, '', 'pdf');
  const replaced = objectOf(TENANT_A, FILE_ID, '_small', 'jpg', 'new bytes');
  const replacedAgain = objectOf(TENANT_A, FILE_ID, '_small', 'jpg', 'newer bytes');

  const originalV2 = { ...original, bytes: Buffer.from('v2') };

  it.each<[string, () => ChangeRow[], (rows: ChangeRow[]) => FileOp[]]>([
    ['an insert as a put of the stored name', () => [change('insert', null, small)], (rows) => [putOf(small, 'tenant-a', rowAt(rows, 0))]],
    ['a delete as a delete of the exact before-image name', () => [change('delete', original, null)], () => [deleteOf(original, 'tenant-a')]],
    [
      'an update of the same key as one put of the new bytes',
      () => [change('update', small, replaced)],
      (rows) => [putOf(replaced, 'tenant-a', rowAt(rows, 0))],
    ],
    [
      'an update of the key as a delete of the old name, then a put of the new one',
      () => [change('update', original, renamed)],
      (rows) => [deleteOf(original, 'tenant-a'), putOf(renamed, 'tenant-a', rowAt(rows, 0))],
    ],
    [
      'a pooled object in the pool site of the umbrella tenant',
      () => [change('insert', null, objectOf(UMBRELLA, FILE_ID, '_medium', 'jpg'))],
      (rows) => [putOf(objectOf(UMBRELLA, FILE_ID, '_medium', 'jpg'), 'umbrella', rowAt(rows, 0))],
    ],
    [
      'two replacements of a key as one put of the last bytes',
      () => [change('insert', null, small), change('update', small, replaced), change('update', replaced, replacedAgain)],
      (rows) => [putOf(replacedAgain, 'tenant-a', rowAt(rows, 2))],
    ],
    [
      'an insert, then a delete, of a key as the delete only',
      () => [change('insert', null, original), change('delete', original, null)],
      () => [deleteOf(original, 'tenant-a')],
    ],
    [
      'a delete, then an insert, of a key as the put only',
      () => [change('delete', original, null), change('insert', null, original)],
      (rows) => [putOf(original, 'tenant-a', rowAt(rows, 1))],
    ],
    [
      'distinct keys in the row order of their last operations',
      () => [change('insert', null, original), change('insert', null, small), change('update', original, originalV2)],
      (rows) => [putOf(small, 'tenant-a', rowAt(rows, 1)), putOf(originalV2, 'tenant-a', rowAt(rows, 2))],
    ],
    [
      'a key renamed and renamed back as a delete of the interim name, then a put of the original one',
      () => [change('update', original, renamed), change('update', renamed, original)],
      (rows) => [deleteOf(renamed, 'tenant-a'), putOf(original, 'tenant-a', rowAt(rows, 1))],
    ],
  ])('plans %s', (_label, rows, expected) => {
    const built = rows();
    expect(planFileOps(built, TENANT_SITES)).toEqual(expected(built));
  });

  it('names an flv rendition `_small.jpg` through formatStoredName', () => {
    const [op] = planFileOps([change('insert', null, objectOf(TENANT_A, FILE_ID, '_small', 'jpg'))], TENANT_SITES);

    expect(op?.name).toBe(`${FILE_ID}_small.jpg`);
  });

  it('throws UnknownFileTenantError for a tenant without a legacy site', () => {
    const stray = objectOf(tenantIdForSite('gone'), FILE_ID, '', 'pdf');

    expect(() => planFileOps([change('insert', null, stray)], TENANT_SITES)).toThrow(UnknownFileTenantError);
    expect(() => planFileOps([change('delete', stray, null)], TENANT_SITES)).toThrow(/No legacy site is known for tenant/);
  });

  it('throws InvalidStoredNameError for a key that is not `<tenant>/<stored name>`', () => {
    const row = change('insert', null, small);
    row.after = encodeRow(COLUMNS, { ...rowOf(small), object_key: `${TENANT_A}/../${FILE_ID}.jpg` });

    expect(() => planFileOps([row], TENANT_SITES)).toThrow(InvalidStoredNameError);
  });

  it('rejects an image of another column layout instead of misreading it', () => {
    const row = change('insert', null, small);
    row.after = encodeRow(COLUMNS.slice(0, -1), rowOf(small));

    expect(() => planFileOps([row], TENANT_SITES)).toThrow(CanonicalEncodingError);
  });

  it('throws when the image the operation needs is absent', () => {
    const row = { ...change('insert', null, small), after: null };

    expect(() => planFileOps([row], TENANT_SITES)).toThrow(TypeError);
  });
});

describe('executeFileOps', () => {
  const small = objectOf(TENANT_A, FILE_ID, '_small', 'jpg');
  const original = objectOf(UMBRELLA, OTHER_ID, '', 'pdf');

  const smallRow = change('insert', null, small);
  const putSmall = putOf(small, 'tenant-a', smallRow);
  const smallPath = `tenant-a/cache/file/${FILE_ID}_small.jpg`;
  const newer = objectOf(TENANT_A, FILE_ID, '_small', 'jpg', 'bytes of a later replacement');
  const tampered = Buffer.alloc(small.bytes.byteLength, 0x58);
  const smallStored = `tenant-a/${FILE_ID}_small.jpg`;
  const absent = (): OwnerCallError => new OwnerCallError('strategies-content', 'GET', OBJECTS_PATH, 404, { error: 'notFound' });
  const rewritten = `Projected legacy file ${smallPath} from ${keyOf(small)} as a later change recorded it: ${String(newer.bytes.byteLength)} bytes`;
  const removed = `Projected delete of legacy file ${smallPath}: a later change removed ${keyOf(small)}; 1 removed`;
  /** A change of another table, whose images are not file objects. */
  const otherTable = (): ChangeRow => ({
    ...change('insert', null, original),
    table: 'file',
    after: encodeRow([{ name: 'FileID', type: 's' }], { FileID: OTHER_ID }),
  });

  it('streams each put with its size and the change row SHA-256, and deletes by exact name', async () => {
    const h = harness([small], { store: [`umbrella/${formatStoredName(original)}`] });

    const result = await executeFileOps(h.deps, [putSmall, deleteOf(original, 'umbrella')]);

    expect(result).toEqual({ put: 1, deleted: 1, bytes: small.bytes.byteLength, superseded: 0 });
    expect(h.getObject).toHaveBeenCalledWith(keyOf(small));
    expect(h.puts).toEqual([
      { siteId: 'tenant-a', name: `${FILE_ID}_small.jpg`, bytes: small.bytes, sha256: sha(small.bytes), size: small.bytes.byteLength },
    ]);
    expect(h.sources.map((source) => source.destroyed)).toEqual([true]);
    expect(h.deletes).toEqual([{ siteId: 'umbrella', target: { name: `${OTHER_ID}.pdf` } }]);
    expect(h.files).toEqual(new Set([`tenant-a/${FILE_ID}_small.jpg`]));
    expect(h.changes).not.toHaveBeenCalled();
    expect(h.info.mock.calls).toEqual([
      [{ tenantId: TENANT_A }, `Projected legacy file ${smallPath} from ${keyOf(small)}: ${String(small.bytes.byteLength)} bytes`],
      [{ tenantId: UMBRELLA }, `Projected delete of legacy file umbrella/cache/file/${OTHER_ID}.pdf: 1 removed`],
    ]);
  });

  it('treats the delete of an absent file as done and runs a repeated batch to the same store', async () => {
    const h = harness([small]);
    const ops = [deleteOf(original, 'umbrella'), putSmall];
    const done = { put: 1, deleted: 0, bytes: small.bytes.byteLength, superseded: 0 };

    await expect(executeFileOps(h.deps, ops)).resolves.toEqual(done);
    await expect(executeFileOps(h.deps, ops)).resolves.toEqual(done);
    expect(h.files).toEqual(new Set([`tenant-a/${FILE_ID}_small.jpg`]));
  });

  it.each<[string, Buffer, boolean]>([
    ['bytes hashing differently', Buffer.from('tampered bytes of the same length!!!!!').subarray(0, small.bytes.byteLength), false],
    ['fewer bytes', small.bytes.subarray(0, small.bytes.byteLength - 1), false],
    ['more bytes', Buffer.concat([small.bytes, Buffer.from('x')]), true],
  ])('throws FileObjectMismatchError for %s without a later change of the key, and writes nothing', async (_label, served, exceeded) => {
    const other = change('insert', null, original);
    const h = harness([{ ...small, bytes: served }], { feed: { [cursorOf(smallRow)]: { rows: [other], complete: true } } });

    const error = await executeFileOps(h.deps, [putSmall]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileObjectMismatchError);
    expect(error).toMatchObject({
      key: keyOf(small),
      expected: { size: small.bytes.byteLength, sha256: sha(small.bytes) },
      actual: { size: served.byteLength, sha256: sha(served) },
      exceeded,
    });
    expect(h.puts).toEqual([]);
    expect(h.files).toEqual(new Set());
    expect(h.consumed.every((count) => count <= small.bytes.byteLength)).toBe(true);
    expect(h.sources.map((source) => source.destroyed)).toEqual([true]);
    expect(h.changes).toHaveBeenCalledExactlyOnceWith('strategies-content', {
      tenantId: TENANT_A,
      after: cursorOf(smallRow),
      limit: CONFIG.projection.batchRows,
    });
  });

  it('stops reading an endless object at the first chunk beyond its size and destroys the stream', async () => {
    const h = harness([]);
    const endless = Readable.from(
      (async function* (): AsyncGenerator<Buffer> {
        for (;;) yield Buffer.alloc(3, 0x61);
      })(),
    );
    h.getObject.mockResolvedValueOnce(endless);

    const error = await executeFileOps(h.deps, [putSmall]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileObjectMismatchError);
    expect(error).toMatchObject({ exceeded: true, actual: { size: Math.floor(small.bytes.byteLength / 3) * 3 + 3 } });
    expect((error as Error).message).toBe(
      `File object ${keyOf(small)} exceeded the change row's ${String(small.bytes.byteLength)} bytes: ` +
        `${String(Math.floor(small.bytes.byteLength / 3) * 3 + 3)} bytes were read`,
    );
    expect(h.consumed).toEqual([Math.floor(small.bytes.byteLength / 3) * 3]);
    expect(endless.destroyed).toBe(true);
  });

  it.each<[string, Buffer, Buffer | null, object]>([
    ['succeeds once the object ends', small.bytes, null, { put: 1, deleted: 0, bytes: small.bytes.byteLength, superseded: 0 }],
    [
      'throws an exceeded FileObjectMismatchError when the object runs on past its size',
      small.bytes,
      Buffer.from('!'),
      { name: 'FileObjectMismatchError', exceeded: true, actual: { size: small.bytes.byteLength + 1 } },
    ],
    [
      'throws FileObjectMismatchError, not the bridge refusal, for other bytes of the same size',
      tampered,
      null,
      { name: 'FileObjectMismatchError', exceeded: false, actual: { size: tampered.byteLength, sha256: sha(tampered) } },
    ],
  ])('reads the object on after a bridge that stops at the sent size answered: %s', async (_label, head, tail, expected) => {
    const h = harness([]);
    const source = new Readable({ read: () => undefined });
    source.push(head);
    h.getObject.mockResolvedValueOnce(source);
    let answered = false;
    h.filesPut.mockImplementationOnce(async (_siteId, name, body, sha256, putOpts) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
        if (Buffer.concat(chunks).byteLength >= (putOpts?.size ?? 0)) break;
      }
      setImmediate(() => {
        answered = true;
        if (tail !== null) source.push(tail);
        source.push(null);
      });
      if (sha(Buffer.concat(chunks)) !== sha256) throw new BridgeError('files.put', 400, { error: 'hashMismatch' });
      return { written: true, name, size: Buffer.concat(chunks).byteLength, sha256, serverTime: '2026-06-30 10:00:00' };
    });

    const outcome = await executeFileOps(h.deps, [putSmall]).catch((caught: unknown) => caught);

    expect(answered).toBe(true);
    expect(outcome).toMatchObject(expected);
    expect(source.destroyed).toBe(true);
  });

  it.each<[string, () => ChangeRow[], boolean]>([
    ['replaced', () => [change('update', small, newer)], false],
    ['inserted again after the owner answered 404 for it', () => [change('delete', small, null), change('insert', null, newer)], true],
  ])('writes the bytes of the later change of an object it %s, checked against that change', async (_label, later, absentFirst) => {
    const h = harness([newer], { feed: { [cursorOf(smallRow)]: { rows: later(), complete: true } } });
    if (absentFirst) h.getObject.mockRejectedValueOnce(absent());

    const result = await executeFileOps(h.deps, [putSmall]);

    expect(result).toEqual({ put: 1, deleted: 0, bytes: newer.bytes.byteLength, superseded: 1 });
    expect(h.puts).toEqual([
      { siteId: 'tenant-a', name: `${FILE_ID}_small.jpg`, bytes: newer.bytes, sha256: sha(newer.bytes), size: newer.bytes.byteLength },
    ]);
    expect(h.files).toEqual(new Set([smallStored]));
    expect(h.filesDelete).not.toHaveBeenCalled();
    expect(h.sources.every((source) => source.destroyed)).toBe(true);
    expect(h.info.mock.calls).toEqual([[{ tenantId: TENANT_A }, rewritten]]);
  });

  it.each<[string, () => ChangeRow]>([
    ['a later delete', () => change('delete', small, null)],
    ['a later update moving it to another key', () => change('update', small, objectOf(TENANT_A, OTHER_ID, '_small', 'jpg'))],
  ])('deletes the legacy file of an object the owner no longer holds after %s', async (_label, later) => {
    const h = harness([], { store: [smallStored], feed: { [cursorOf(smallRow)]: { rows: [later()], complete: true } } });

    await expect(executeFileOps(h.deps, [putSmall])).resolves.toEqual({ put: 0, deleted: 1, bytes: 0, superseded: 1 });
    expect(h.filesPut).not.toHaveBeenCalled();
    expect(h.deletes).toEqual([{ siteId: 'tenant-a', target: { name: `${FILE_ID}_small.jpg` } }]);
    expect(h.files).toEqual(new Set());
    expect(h.info.mock.calls).toEqual([[{ tenantId: TENANT_A }, removed]]);
  });

  it.each<[string, StoredObject[], () => ChangeRow[], () => ChangeRow[], object, string[]]>([
    [
      'a removal',
      [],
      () => [otherTable(), change('update', small, newer)],
      () => [change('delete', newer, null)],
      { put: 0, deleted: 1, bytes: 0, superseded: 1 },
      [],
    ],
    [
      'a replacement',
      [newer],
      () => [change('delete', small, null)],
      () => [otherTable(), change('insert', null, newer)],
      { put: 1, deleted: 0, bytes: newer.bytes.byteLength, superseded: 1 },
      [smallStored],
    ],
  ])('reads the change feed page by page until it is complete, applying the last change of the key: %s', async (_label, served, first, second, expected, stored) => {
    const firstRows = first();
    const feed = {
      [cursorOf(smallRow)]: { rows: firstRows, complete: false },
      [cursorOf(rowAt(firstRows, firstRows.length - 1))]: { rows: second(), complete: true },
    };
    const h = harness(served, { store: [smallStored], feed, batchRows: 2 });

    await expect(executeFileOps(h.deps, [putSmall])).resolves.toEqual(expected);
    expect(h.files).toEqual(new Set(stored));
    expect(h.changes.mock.calls.map(([owner, params]) => [owner, params])).toEqual([
      ['strategies-content', { tenantId: TENANT_A, after: cursorOf(smallRow), limit: 2 }],
      ['strategies-content', { tenantId: TENANT_A, after: cursorOf(rowAt(firstRows, firstRows.length - 1)), limit: 2 }],
    ]);
  });

  it.each<[string, StoredObject[], object]>([
    [
      'differs from the later change too',
      [objectOf(TENANT_A, FILE_ID, '_small', 'jpg', 'bytes of a change the feed has not shown')],
      { name: 'FileObjectMismatchError', expected: { size: newer.bytes.byteLength, sha256: sha(newer.bytes) } },
    ],
    ['is absent again', [], { name: 'OwnerCallError', status: 404 }],
  ])('lets the put of the later state fail when the current object %s, writing nothing', async (_label, served, expected) => {
    const h = harness(served, { feed: { [cursorOf(smallRow)]: { rows: [change('update', small, newer)], complete: true } } });

    const error = await executeFileOps(h.deps, [putSmall]).catch((caught: unknown) => caught);

    expect(error).toMatchObject(expected);
    expect(h.getObject).toHaveBeenCalledTimes(2);
    expect(h.changes).toHaveBeenCalledOnce();
    expect(h.puts).toEqual([]);
    expect(h.files).toEqual(new Set());
    expect(h.filesDelete).not.toHaveBeenCalled();
  });

  it('lets a bridge error answered before the object was sent propagate, without awaiting its end or reading the change feed', async () => {
    const h = harness([]);
    const unfinished = new Readable({ read: () => undefined });
    h.getObject.mockResolvedValueOnce(unfinished);
    const refusal = new UnsupportedFileStoreError('files.put', { error: 'unsupportedFileStore' });
    h.filesPut.mockRejectedValueOnce(refusal);

    await expect(executeFileOps(h.deps, [putSmall])).rejects.toBe(refusal);
    expect(h.changes).not.toHaveBeenCalled();
    expect(unfinished.destroyed).toBe(true);
  });

  it('stops at an absent object no later change explains, leaving later operations unrun', async () => {
    const h = harness([]);

    const error = await executeFileOps(h.deps, [putSmall, deleteOf(original, 'umbrella')]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OwnerCallError);
    expect(error).toMatchObject({ status: 404, path: OBJECTS_PATH });
    expect(h.changes).toHaveBeenCalledOnce();
    expect(h.filesDelete).not.toHaveBeenCalled();
  });
});
