// Unit tests for projecting content.file_object changes onto the legacy file store through fake owners and bridge.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { Logger } from '@opt2/platform/logging';
import { CanonicalEncodingError, encodeKey, encodeRow, type CanonicalColumn, type ChangeOp, type ChangeRow } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { describe, expect, it, vi } from 'vitest';

import { InvalidStoredNameError, formatStoredName, type StoredVariant } from '../../src/files/index.js';
import { UnsupportedFileStoreError, type BridgeClient, type FileDeleteTarget } from '../../src/legacy/bridge.js';
import type { OwnersClient } from '../../src/owners/client.js';
import {
  FILE_OBJECT_UNIT,
  FileObjectMismatchError,
  UnknownFileTenantError,
  executeFileOps,
  isFileObjectChange,
  planFileOps,
  type FileOp,
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

function putOf(o: StoredObject, siteId: string): FileOp {
  return { kind: 'put', tenantId: o.tenantId, siteId, key: keyOf(o), name: formatStoredName(o), size: o.bytes.byteLength, sha256: sha(o.bytes) };
}

function deleteOf(o: StoredObject, siteId: string): FileOp {
  return { kind: 'delete', tenantId: o.tenantId, siteId, key: keyOf(o), name: formatStoredName(o) };
}

/** Fake owners serving `objects` by key, a fake bridge store keyed `<siteId>/<name>`, and a recording logger. */
function harness(objects: StoredObject[], store: string[] = []) {
  const files = new Set(store);
  const puts: Array<{ siteId: string; name: string; bytes: Buffer; sha256: string }> = [];
  const deletes: Array<{ siteId: string; target: FileDeleteTarget }> = [];
  const served = new Map(objects.map((o) => [keyOf(o), o.bytes]));
  const getObject = vi.fn((key: string) => {
    const bytes = served.get(key);
    return bytes === undefined ? Promise.reject(new Error(`no object ${key}`)) : Promise.resolve(bytes);
  });
  const filesPut = vi.fn((siteId: string, name: string, bytes: Buffer | Uint8Array, sha256: string) => {
    puts.push({ siteId, name, bytes: Buffer.from(bytes), sha256 });
    files.add(`${siteId}/${name}`);
    return Promise.resolve({ written: true, name, size: bytes.byteLength, sha256, serverTime: '2026-06-30 10:00:00' });
  });
  const filesDelete = vi.fn((siteId: string, target: FileDeleteTarget) => {
    deletes.push({ siteId, target });
    const path = `${siteId}/${'name' in target ? target.name : target.fileId}`;
    const removed = files.delete(path) ? ['name' in target ? target.name : target.fileId] : [];
    return Promise.resolve({ deleted: removed, serverTime: '2026-06-30 10:00:00' });
  });
  const info = vi.fn();
  const deps = {
    owners: { getObject } as unknown as OwnersClient,
    bridge: { filesPut, filesDelete } as unknown as BridgeClient,
    logger: { info } as unknown as Logger,
  };
  return { deps, puts, deletes, files, getObject, filesPut, filesDelete, info };
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

  it.each<[string, () => ChangeRow[], () => FileOp[]]>([
    ['an insert as a put of the stored name', () => [change('insert', null, small)], () => [putOf(small, 'tenant-a')]],
    ['a delete as a delete of the exact before-image name', () => [change('delete', original, null)], () => [deleteOf(original, 'tenant-a')]],
    [
      'an update of the same key as one put of the new bytes',
      () => [change('update', small, objectOf(TENANT_A, FILE_ID, '_small', 'jpg', 'new bytes'))],
      () => [putOf(objectOf(TENANT_A, FILE_ID, '_small', 'jpg', 'new bytes'), 'tenant-a')],
    ],
    [
      'an update of the key as a delete of the old name, then a put of the new one',
      () => [change('update', original, objectOf(TENANT_A, OTHER_ID, '', 'pdf'))],
      () => [deleteOf(original, 'tenant-a'), putOf(objectOf(TENANT_A, OTHER_ID, '', 'pdf'), 'tenant-a')],
    ],
    [
      'a pooled object in the pool site of the umbrella tenant',
      () => [change('insert', null, objectOf(UMBRELLA, FILE_ID, '_medium', 'jpg'))],
      () => [putOf(objectOf(UMBRELLA, FILE_ID, '_medium', 'jpg'), 'umbrella')],
    ],
    [
      'several rows in row order',
      () => [change('insert', null, small), change('delete', original, null), change('insert', null, original)],
      () => [putOf(small, 'tenant-a'), deleteOf(original, 'tenant-a'), putOf(original, 'tenant-a')],
    ],
  ])('plans %s', (_label, rows, expected) => {
    expect(planFileOps(rows(), TENANT_SITES)).toEqual(expected());
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

  it('writes each put with the owner bytes and their SHA-256, and deletes by exact name', async () => {
    const h = harness([small], [`umbrella/${formatStoredName(original)}`]);

    const result = await executeFileOps(h.deps, [putOf(small, 'tenant-a'), deleteOf(original, 'umbrella')]);

    expect(result).toEqual({ put: 1, deleted: 1, bytes: small.bytes.byteLength });
    expect(h.getObject).toHaveBeenCalledWith(keyOf(small));
    expect(h.puts).toEqual([{ siteId: 'tenant-a', name: `${FILE_ID}_small.jpg`, bytes: small.bytes, sha256: sha(small.bytes) }]);
    expect(h.deletes).toEqual([{ siteId: 'umbrella', target: { name: `${OTHER_ID}.pdf` } }]);
    expect(h.files).toEqual(new Set([`tenant-a/${FILE_ID}_small.jpg`]));
    expect(h.info.mock.calls).toEqual([
      [{ tenantId: TENANT_A }, `Projected legacy file tenant-a/cache/file/${FILE_ID}_small.jpg from ${keyOf(small)}: ${String(small.bytes.byteLength)} bytes`],
      [{ tenantId: UMBRELLA }, `Projected delete of legacy file umbrella/cache/file/${OTHER_ID}.pdf: 1 removed`],
    ]);
  });

  it('treats the delete of an absent file as done and runs a repeated batch to the same store', async () => {
    const h = harness([small]);
    const ops = [deleteOf(original, 'umbrella'), putOf(small, 'tenant-a')];

    await expect(executeFileOps(h.deps, ops)).resolves.toEqual({ put: 1, deleted: 0, bytes: small.bytes.byteLength });
    await expect(executeFileOps(h.deps, ops)).resolves.toEqual({ put: 1, deleted: 0, bytes: small.bytes.byteLength });
    expect(h.files).toEqual(new Set([`tenant-a/${FILE_ID}_small.jpg`]));
  });

  it.each<[string, Buffer]>([
    ['bytes hashing differently', Buffer.from('tampered bytes of the same length!!!!!').subarray(0, small.bytes.byteLength)],
    ['bytes of another size', Buffer.concat([small.bytes, Buffer.from('x')])],
  ])('throws FileObjectMismatchError and writes nothing for %s', async (_label, served) => {
    const h = harness([{ ...small, bytes: served }]);
    const op = putOf(small, 'tenant-a');

    const error = await executeFileOps(h.deps, [op]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileObjectMismatchError);
    expect(error).toMatchObject({
      key: keyOf(small),
      expected: { size: small.bytes.byteLength, sha256: sha(small.bytes) },
      actual: { size: served.byteLength, sha256: sha(served) },
    });
    expect(h.filesPut).not.toHaveBeenCalled();
  });

  it('lets UnsupportedFileStoreError from the bridge propagate', async () => {
    const h = harness([small]);
    h.filesPut.mockRejectedValueOnce(new UnsupportedFileStoreError('files.put', { error: 'unsupportedFileStore' }));

    await expect(executeFileOps(h.deps, [putOf(small, 'tenant-a')])).rejects.toBeInstanceOf(UnsupportedFileStoreError);
  });

  it('stops at the first failure, leaving later operations unrun', async () => {
    const h = harness([]);

    await expect(executeFileOps(h.deps, [putOf(small, 'tenant-a'), deleteOf(original, 'umbrella')])).rejects.toThrow(`no object ${keyOf(small)}`);
    expect(h.filesDelete).not.toHaveBeenCalled();
  });
});
