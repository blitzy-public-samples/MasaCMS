import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { Storage } from '@google-cloud/storage';
import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudStorageAdapter } from '../../src/storage/cloud-adapter.js';
import * as storageBarrel from '../../src/storage/index.js';
import { legacyFileHeaders, legacyHeaderValue, sendLegacyFile } from '../../src/storage/legacy-stream.js';
import {
  STORAGE_DIR,
  createLocalStorageAdapter,
  loadStorageHmacKey,
  signLocalUrl,
  verifySignedUrl,
  type LocalStorageAdapter,
} from '../../src/storage/local-adapter.js';
import {
  BUCKETS,
  InvalidObjectKeyError,
  LOCAL_SIGNED_URL_PREFIX,
  SHA256_METADATA_KEY,
  SIGNED_URL_TTL_S,
  StorageObjectNotFoundError,
  UnknownBucketError,
  assertBucket,
  assertObjectKey,
  contentFileKey,
  createStoragePort,
  isBucketName,
  objectKey,
  type BucketName,
  type ContentFileVariant,
  type PutBody,
  type StoragePort,
} from '../../src/storage/port.js';
import { TENANT_A, TENANT_B } from '../../src/testing/fixtures.js';

// Assembled at run time, so no literal key appears in source.
const HMAC_KEY = Buffer.from(['opt2', 'storage', 'unit', 'hmac'].join('-'), 'utf8');
const OTHER_HMAC_KEY = Buffer.from(['opt2', 'storage', 'other', 'hmac'].join('-'), 'utf8');
const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0, 250);
const NOW_S = Math.floor(NOW_MS / 1000);
const FILE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const CF_UUID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}';
const CONTENT_KEY = `${TENANT_A.tenantId}/F1_small.jpg`;
const ANY_SIG = 'a'.repeat(64);
const LAST_MODIFIED = new Date(Date.UTC(2025, 5, 1, 8, 30, 0));
const LAST_MODIFIED_HTTP = 'Sun, 01 Jun 2025 08:30:00 GMT';

const fsFaults = vi.hoisted((): { rename?: Error } => ({}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsFaults.rename) throw fsFaults.rename;
      return actual.rename(...args);
    },
  };
});

const stateDirs: string[] = [];

async function newStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-storage-'));
  stateDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete fsFaults.rename;
  await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hmacHex(signed: string, key: Buffer = HMAC_KEY): string {
  return createHmac('sha256', key).update(signed, 'utf8').digest('hex');
}

function trailer(json: string, length = Buffer.byteLength(json), marker = 'OPT2OBJ1'): Buffer {
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(length);
  return Buffer.concat([Buffer.from(json, 'utf8'), lengthBytes, Buffer.from(marker, 'latin1')]);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** Raw response bytes of a GET over a loopback socket, headers as written on the wire. */
async function rawHttpGet(port: number, target: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
  });
}

describe('storage keys and constants', () => {
  it('declares the four buckets, a 900 s URL lifetime, the /opt2/files/ prefix and the sha256 metadata key', () => {
    expect(BUCKETS).toEqual(['content-files', 'reporting-exports', 'finance-attachments', 'esignature-documents']);
    expect(SIGNED_URL_TTL_S).toBe(900);
    expect(LOCAL_SIGNED_URL_PREFIX).toBe('/opt2/files/');
    expect(SHA256_METADATA_KEY).toBe('sha256');
  });

  it.each(BUCKETS)('accepts the bucket %s', (bucket) => {
    expect(isBucketName(bucket)).toBe(true);
    expect(assertBucket(bucket)).toBe(bucket);
  });

  it.each(['', 'content', 'Content-Files', 'content-files/', 'tasks'])('rejects the bucket name %j', (name) => {
    expect(isBucketName(name)).toBe(false);
    expect(() => assertBucket(name)).toThrow(UnknownBucketError);
    expect(() => assertBucket(name)).toThrow(`Unknown storage bucket: ${JSON.stringify(name)}`);
  });

  it('carries the offending bucket on UnknownBucketError', () => {
    const err = new UnknownBucketError('tasks');
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: 'UnknownBucketError', bucket: 'tasks' });
  });

  it.each(['a', 'a/b.jpg', CONTENT_KEY, '.hidden', 'a..b/...', 'dir with space/ï.txt'])(
    'accepts the object key %j',
    (key) => {
      expect(assertObjectKey(key)).toBe(key);
    },
  );

  it.each(['', '/a', 'a/', 'a//b', '.', './a', 'a/.', '..', 'a/../b', 'a\\b', 'a\0b'])(
    'rejects the object key %j with InvalidObjectKeyError',
    (key) => {
      let caught: unknown;
      try {
        assertObjectKey(key);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidObjectKeyError);
      expect(caught).toMatchObject({ name: 'InvalidObjectKeyError', key });
      expect((caught as Error).message).toContain(`Invalid object key ${JSON.stringify(key)}:`);
    },
  );

  it.each<[string, { variant?: ContentFileVariant; ext: string }, string]>([
    ['a rendition suffix', { variant: '_small', ext: 'jpg' }, 'F1_small.jpg'],
    ['an empty variant', { variant: '', ext: 'jpg' }, 'F1.jpg'],
    ['an omitted variant and an upper-case extension', { ext: 'JPG' }, 'F1.jpg'],
    ['the source rendition', { variant: '_source', ext: 'Png' }, 'F1_source.png'],
    ['a custom image-size name', { variant: '_hero-wide_2', ext: 'webp' }, 'F1_hero-wide_2.webp'],
    ['a width and height rendition', { variant: '_W100_H50', ext: 'jpg' }, 'F1_W100_H50.jpg'],
    ['a decimal width with an automatic height', { variant: '_W200.5_HAUTO', ext: 'png' }, 'F1_W200.5_HAUTO.png'],
    ['a unicode image-size name', { variant: '_größe-ü', ext: 'gif' }, 'F1_größe-ü.gif'],
    ['a mixed-case variant', { variant: '_Small', ext: 'jpg' }, 'F1_Small.jpg'],
    ['a dotted variant', { variant: '_a.b', ext: 'jpg' }, 'F1_a.b.jpg'],
  ])('builds the content-file key for %s', (_case, parts, expectedName) => {
    expect(contentFileKey({ tenantId: TENANT_A.tenantId, fileId: 'F1', ...parts })).toBe(
      `${TENANT_A.tenantId}/${expectedName}`,
    );
  });

  it.each(['small', '_', '_a/b', '_a\\b', '_a\0b', '_a\u001fb', '_a\u007fb'])(
    'rejects the content-file variant %j',
    (variant) => {
      expect(() =>
        contentFileKey({ tenantId: TENANT_A.tenantId, fileId: 'F1', variant: variant as ContentFileVariant, ext: 'jpg' }),
      ).toThrow(InvalidObjectKeyError);
    },
  );

  it('generates a fresh 35-character CF UUID for an object key without an id', () => {
    const first = objectKey({ tenantId: TENANT_A.tenantId, ext: 'pdf' });
    const second = objectKey({ tenantId: TENANT_A.tenantId, ext: 'pdf' });
    expect(first).toMatch(new RegExp(`^${TENANT_A.tenantId}/${CF_UUID}\\.pdf$`));
    expect(first.slice(TENANT_A.tenantId.length + 1, -'.pdf'.length)).toHaveLength(35);
    expect(second).not.toBe(first);
  });

  it.each([FILE_ID, FILE_ID.toLowerCase()])('uses the given CF UUID %s verbatim in the object key', (id) => {
    expect(objectKey({ tenantId: TENANT_B.tenantId, id, ext: 'xlsx' })).toBe(`${TENANT_B.tenantId}/${id}.xlsx`);
  });

  it.each(['F1', '6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c', `${FILE_ID}/x`])('rejects the object id %j', (id) => {
    expect(() => objectKey({ tenantId: TENANT_A.tenantId, id, ext: 'pdf' })).toThrow(InvalidObjectKeyError);
  });

  it('selects the local adapter with the injected key and clock', async () => {
    const stateDir = await newStateDir();
    const port = await createStoragePort(
      { OPT2_STORAGE_ADAPTER: 'local', OPT2_STATE_DIR: stateDir },
      { hmacKey: HMAC_KEY, now: () => NOW_MS },
    );
    expect(port.kind).toBe('local');
    const url = await port.signedUrl('content-files', CONTENT_KEY);
    expect(url).toContain(`?expires=${NOW_S + SIGNED_URL_TTL_S}&sig=`);
    expect(verifySignedUrl(url, NOW_MS, HMAC_KEY)).toMatchObject({ ok: true, key: CONTENT_KEY });
  });

  it('refuses the local adapter without OPT2_STATE_DIR', async () => {
    await expect(createStoragePort({ OPT2_STORAGE_ADAPTER: 'local' }, { hmacKey: HMAC_KEY })).rejects.toThrow(
      'OPT2_STATE_DIR is required for the local storage adapter',
    );
  });

  it('selects the Cloud Storage adapter without contacting Cloud Storage', async () => {
    const port = await createStoragePort({ OPT2_STORAGE_ADAPTER: 'cloud', GOOGLE_CLOUD_PROJECT: 'opt2-unit' });
    expect(port.kind).toBe('cloud');
  });
});

describe('storage barrel', () => {
  it('re-exports the port, the local adapter and the legacy stream, and leaves the Cloud Storage factory out', () => {
    expect(storageBarrel).toMatchObject({
      BUCKETS,
      SIGNED_URL_TTL_S,
      LOCAL_SIGNED_URL_PREFIX,
      SHA256_METADATA_KEY,
      StorageObjectNotFoundError,
      UnknownBucketError,
      InvalidObjectKeyError,
      isBucketName,
      assertBucket,
      assertObjectKey,
      contentFileKey,
      objectKey,
      createStoragePort,
      createLocalStorageAdapter,
      loadStorageHmacKey,
      signLocalUrl,
      verifySignedUrl,
      sendLegacyFile,
      legacyFileHeaders,
      legacyHeaderValue,
    });
    expect(Object.keys(storageBarrel)).toHaveLength(20);
    expect(storageBarrel).not.toHaveProperty('createCloudStorageAdapter');
  });
});

describe('local storage adapter', () => {
  const bucket: BucketName = 'finance-attachments';
  const key = `${TENANT_A.tenantId}/${FILE_ID}.pdf`;
  const pdf = Buffer.from('%PDF-1.7\nsynthetic attachment\n', 'utf8');
  let stateDir: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    stateDir = await newStateDir();
    adapter = await createLocalStorageAdapter({ stateDir, hmacKey: HMAC_KEY, now: () => NOW_MS });
  });

  it('stores one file at <stateDir>/storage/<bucket>/<key>: the bytes, then the trailer', async () => {
    const result = await adapter.put(bucket, key, pdf, { contentType: 'application/pdf' });

    expect(adapter.kind).toBe('local');
    expect(result).toEqual({ size: pdf.length, sha256: sha256Hex(pdf) });
    expect(await readFile(path.join(stateDir, STORAGE_DIR, bucket, TENANT_A.tenantId, `${FILE_ID}.pdf`))).toEqual(
      Buffer.concat([pdf, trailer(JSON.stringify({ contentType: 'application/pdf', sha256: sha256Hex(pdf) }))]),
    );
    expect(await readdir(path.join(stateDir, STORAGE_DIR))).toEqual([bucket]);
  });

  it('reports size, SHA-256 and content type from head, and returns the bytes from get and stream', async () => {
    await adapter.put(bucket, key, pdf, { contentType: 'application/pdf' });

    expect(await adapter.head(bucket, key)).toEqual({
      size: pdf.length,
      sha256: sha256Hex(pdf),
      contentType: 'application/pdf',
    });
    expect(await adapter.get(bucket, key)).toEqual(pdf);
    expect(await readAll(await adapter.stream(bucket, key))).toEqual(pdf);
  });

  it.each<[string, () => PutBody, Buffer]>([
    ['a Buffer', () => Buffer.from('buffer body'), Buffer.from('buffer body')],
    ['a Uint8Array', () => new Uint8Array([0x00, 0xff, 0x10, 0x80]), Buffer.from([0x00, 0xff, 0x10, 0x80])],
    [
      'a multi-chunk Readable',
      () => Readable.from([Buffer.from('first '), Buffer.from('second')]),
      Buffer.from('first second'),
    ],
    ['an empty Buffer', () => Buffer.alloc(0), Buffer.alloc(0)],
  ])('hashes and stores %s body', async (_kind, body, bytes) => {
    expect(await adapter.put(bucket, key, body(), { contentType: 'application/octet-stream' })).toEqual({
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
    expect(await adapter.head(bucket, key)).toEqual({
      size: bytes.length,
      sha256: sha256Hex(bytes),
      contentType: 'application/octet-stream',
    });
    expect(await adapter.get(bucket, key)).toEqual(bytes);
    expect(await readAll(await adapter.stream(bucket, key))).toEqual(bytes);
    const opened = await adapter.open(bucket, key);
    expect(opened.head).toEqual(await adapter.head(bucket, key));
    expect(await readAll(opened.body)).toEqual(bytes);
  });

  it('replaces the previous version on put', async () => {
    const csv = Buffer.from('a,b\n1,2\n');
    await adapter.put(bucket, key, pdf, { contentType: 'application/pdf' });
    await adapter.put(bucket, key, csv, { contentType: 'text/csv' });

    expect(await adapter.get(bucket, key)).toEqual(csv);
    expect(await adapter.head(bucket, key)).toEqual({
      size: csv.length,
      sha256: sha256Hex(csv),
      contentType: 'text/csv',
    });
  });

  it.each<[string, () => PutBody, string]>([
    [
      'the body fails mid-write',
      () =>
        Readable.from(
          (function* () {
            yield Buffer.from('partial bytes');
            throw new Error('upstream body failed');
          })(),
        ),
      'upstream body failed',
    ],
    [
      'the commit rename fails',
      () => {
        fsFaults.rename = new Error('rename failed');
        return Buffer.from('replacement bytes');
      },
      'rename failed',
    ],
  ])('keeps the previous version and leaves no partial file when %s', async (_case, body, message) => {
    await adapter.put(bucket, key, pdf, { contentType: 'application/pdf' });

    await expect(adapter.put(bucket, key, body(), { contentType: 'text/plain' })).rejects.toThrow(message);
    delete fsFaults.rename;
    expect(await adapter.head(bucket, key)).toEqual({
      size: pdf.length,
      sha256: sha256Hex(pdf),
      contentType: 'application/pdf',
    });
    expect(await adapter.get(bucket, key)).toEqual(pdf);
    expect(await readAll(await adapter.stream(bucket, key))).toEqual(pdf);
    expect(await readdir(path.join(stateDir, STORAGE_DIR, bucket, TENANT_A.tenantId))).toEqual([`${FILE_ID}.pdf`]);
  });

  it('leaves head, get and stream on one version after concurrent puts to one key', async () => {
    const type = (i: number): string => `application/x-gen-${String(i)}`;
    for (let round = 0; round < 20; round++) {
      const bodies = Array.from({ length: 8 }, (_, i) => Buffer.alloc(1024 * (i + 1) + round, i));
      await Promise.all(bodies.map((b, i) => adapter.put(bucket, key, b, { contentType: type(i) })));

      const bytes = await adapter.get(bucket, key);
      const gen = bytes[0] ?? -1;
      expect(bytes).toEqual(bodies[gen]);
      expect(await adapter.head(bucket, key)).toEqual({
        size: bytes.length,
        sha256: sha256Hex(bytes),
        contentType: type(gen),
      });
      expect(await readAll(await adapter.stream(bucket, key))).toEqual(bytes);
    }
  });

  it('pairs every open racing concurrent puts with the head of the version it reads', async () => {
    const type = (i: number): string => `application/x-gen-${String(i)}`;
    await adapter.put(bucket, key, Buffer.alloc(16, 0), { contentType: type(0) });
    for (let round = 0; round < 10; round++) {
      const bodies = Array.from({ length: 8 }, (_, i) => Buffer.alloc(1024 * (i + 1) + round, i));
      const [, opens] = await Promise.all([
        Promise.all(bodies.map((b, i) => adapter.put(bucket, key, b, { contentType: type(i) }))),
        Promise.all(bodies.map(() => adapter.open(bucket, key))),
      ]);

      for (const { head, body } of opens) {
        const bytes = await readAll(body);
        expect(head).toEqual({ size: bytes.length, sha256: sha256Hex(bytes), contentType: type(bytes[0] ?? -1) });
      }
    }
  });

  it('keeps a stream or open made before a replacing put on the old version, and head and get on the new', async () => {
    const old = Buffer.alloc(256 * 1024, 0x61);
    const csv = Buffer.from('a,b\n1,2\n');
    await adapter.put(bucket, key, old, { contentType: 'application/pdf' });

    const opened = await adapter.stream(bucket, key);
    const openedWithHead = await adapter.open(bucket, key);
    await adapter.put(bucket, key, csv, { contentType: 'text/csv' });

    expect(await adapter.head(bucket, key)).toEqual({
      size: csv.length,
      sha256: sha256Hex(csv),
      contentType: 'text/csv',
    });
    expect(await readAll(opened)).toEqual(old);
    expect(await adapter.get(bucket, key)).toEqual(csv);
    expect(openedWithHead.head).toEqual({ size: old.length, sha256: sha256Hex(old), contentType: 'application/pdf' });
    expect(await readAll(openedWithHead.body)).toEqual(old);
  });

  it.each<[string, Buffer]>([
    ['bytes without a trailer', Buffer.from('%PDF-1.7 written around the adapter\n')],
    ['fewer bytes than a trailer', Buffer.from('OPT2OBJ1')],
    ['a trailer with another marker', trailer('{"contentType":"text/plain","sha256":""}', undefined, 'OPT2OBJ0')],
    ['a trailer length beyond the file', trailer('{}', 0xffffffff)],
    ['an unparsable trailer', Buffer.concat([pdf, trailer('{"contentType":')])],
    ['a trailer without a content type', Buffer.concat([pdf, trailer(JSON.stringify({ sha256: sha256Hex(pdf) }))])],
  ])('rejects an object file holding %s, naming its bucket and key', async (_case, bytes) => {
    const file = path.join(stateDir, STORAGE_DIR, bucket, ...key.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    const message = `Storage object has no valid trailer: ${bucket}/${key}`;

    await expect(adapter.head(bucket, key)).rejects.toThrow(message);
    await expect(adapter.get(bucket, key)).rejects.toThrow(message);
    await expect(adapter.stream(bucket, key)).rejects.toThrow(message);
    await expect(adapter.open(bucket, key)).rejects.toThrow(message);
  });

  it('deletes the object and its metadata, and deleting it again is not an error', async () => {
    await adapter.put(bucket, key, pdf, { contentType: 'application/pdf' });
    await adapter.delete(bucket, key);

    expect(await adapter.head(bucket, key)).toBeNull();
    await expect(adapter.get(bucket, key)).rejects.toThrow(StorageObjectNotFoundError);
    await expect(adapter.stream(bucket, key)).rejects.toThrow(StorageObjectNotFoundError);
    await expect(adapter.delete(bucket, key)).resolves.toBeUndefined();
  });

  it('reports an object never stored as absent, naming its bucket and key', async () => {
    expect(await adapter.head(bucket, key)).toBeNull();
    await expect(adapter.get(bucket, key)).rejects.toMatchObject({
      name: 'StorageObjectNotFoundError',
      bucket,
      key,
      message: `Storage object not found: ${bucket}/${key}`,
    });
    await expect(adapter.stream(bucket, key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    await expect(adapter.open(bucket, key)).rejects.toMatchObject({ name: 'StorageObjectNotFoundError', bucket, key });
  });

  it.each<[string, string, string]>([
    ['a key below an existing object', 'parent', 'parent/child'],
    ['a key naming a directory of other objects', 'parent/child', 'parent'],
  ])('reports %s as absent', async (_case, stored, queried) => {
    await adapter.put(bucket, stored, pdf, { contentType: 'application/pdf' });

    expect(await adapter.head(bucket, queried)).toBeNull();
    await expect(adapter.get(bucket, queried)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    await expect(adapter.stream(bucket, queried)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it.each<[string, (a: LocalStorageAdapter, k: string) => Promise<unknown>]>([
    ['get', (a, k) => a.get(bucket, k)],
    ['stream', (a, k) => a.stream(bucket, k)],
    ['open', (a, k) => a.open(bucket, k)],
    ['head', (a, k) => a.head(bucket, k)],
    ['put', (a, k) => a.put(bucket, k, Buffer.from('x'), { contentType: 'text/plain' })],
  ])('%s propagates a filesystem error other than a missing path', async (_op, run) => {
    await adapter.put(bucket, 'sibling', pdf, { contentType: 'application/pdf' });

    await expect(run(adapter, 'x'.repeat(300))).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
  });

  it('rejects unknown buckets and unsafe keys before touching the disk', async () => {
    await expect(adapter.put('tasks' as BucketName, key, pdf, { contentType: 'application/pdf' })).rejects.toThrow(
      UnknownBucketError,
    );
    await expect(adapter.put(bucket, '../escape', pdf, { contentType: 'application/pdf' })).rejects.toThrow(
      InvalidObjectKeyError,
    );
    await expect(adapter.get(bucket, 'a/../../escape')).rejects.toThrow(InvalidObjectKeyError);
    await expect(adapter.head('tasks' as BucketName, key)).rejects.toThrow(UnknownBucketError);
    await expect(adapter.signedUrl('tasks' as BucketName, key)).rejects.toThrow(UnknownBucketError);
    await expect(adapter.signedUrl(bucket, 'a//b')).rejects.toThrow(InvalidObjectKeyError);
    expect(await readdir(stateDir)).toEqual([]);
  });

  it('signs a path-only URL that expires 900 s after the injected clock', async () => {
    const expires = NOW_S + 900;
    const sig = hmacHex(`content-files/${CONTENT_KEY}\n${expires}`);
    const url = await adapter.signedUrl('content-files', CONTENT_KEY);

    expect(url).toBe(`/opt2/files/content-files/${CONTENT_KEY}?expires=${expires}&sig=${sig}`);
    expect(adapter.verifySignedUrl(url)).toEqual({ ok: true, bucket: 'content-files', key: CONTENT_KEY, expires });
  });

  it('signs a custom lifetime and the download disposition', async () => {
    const disposition = 'attachment; filename="report 1.pdf"';
    const expires = NOW_S + 60;
    const url = await adapter.signedUrl(bucket, key, { expiresS: 60, disposition });

    expect(url).toBe(
      `/opt2/files/${bucket}/${key}?expires=${expires}&sig=${hmacHex(`${bucket}/${key}\n${expires}\n${disposition}`)}` +
        `&disposition=${encodeURIComponent(disposition)}`,
    );
    expect(adapter.verifySignedUrl(url)).toEqual({ ok: true, bucket, key, expires, disposition });
  });

  it('percent-encodes each key segment and verifies back to the raw key', async () => {
    const rawKey = `${TENANT_A.tenantId}/dir with space/ï#?.txt`;
    const url = await adapter.signedUrl('content-files', rawKey);

    expect(url.split('?')[0]).toBe(
      `/opt2/files/content-files/${TENANT_A.tenantId}/dir%20with%20space/%C3%AF%23%3F.txt`,
    );
    expect(adapter.verifySignedUrl(url)).toMatchObject({ ok: true, key: rawKey });
  });

  it('uses the adapter clock by default and an explicit instant when given', async () => {
    const url = await adapter.signedUrl(bucket, key, { expiresS: 1 });

    expect(adapter.verifySignedUrl(url)).toMatchObject({ ok: true });
    expect(adapter.verifySignedUrl(url, NOW_MS + 5_000)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('local signed URLs', () => {
  const expires = NOW_S + 900;
  const signed = signLocalUrl({ bucket: 'content-files', key: CONTENT_KEY, expires }, HMAC_KEY);

  it('formats /opt2/files/<bucket>/<key>?expires=<s>&sig=<hex>', () => {
    const url = signLocalUrl(
      { bucket: 'reporting-exports', key: `${TENANT_B.tenantId}/${FILE_ID}.csv`, expires: 1_800_000_000 },
      HMAC_KEY,
    );

    expect(url).toMatch(/^\/opt2\/files\/reporting-exports\/[^?]+\?expires=\d+&sig=[0-9a-f]{64}$/);
    expect(url).toBe(
      `/opt2/files/reporting-exports/${TENANT_B.tenantId}/${FILE_ID}.csv?expires=1800000000` +
        `&sig=${hmacHex(`reporting-exports/${TENANT_B.tenantId}/${FILE_ID}.csv\n1800000000`)}`,
    );
  });

  it('accepts an absolute URL and a Date clock', () => {
    expect(verifySignedUrl(`http://127.0.0.1:8100${signed}`, new Date(NOW_MS), HMAC_KEY)).toEqual({
      ok: true,
      bucket: 'content-files',
      key: CONTENT_KEY,
      expires,
    });
  });

  it('accepts the URL until the end of its expiry second, then reports it expired', () => {
    expect(verifySignedUrl(signed, expires * 1000 + 999, HMAC_KEY)).toMatchObject({ ok: true });
    expect(verifySignedUrl(signed, (expires + 1) * 1000, HMAC_KEY)).toEqual({ ok: false, reason: 'expired' });
  });

  it.each<[string, string]>([
    ['an unparseable URL', `http://[::1/opt2/files/content-files/a?expires=1&sig=${ANY_SIG}`],
    ['a path outside /opt2/files/', `/opt2/other/content-files/a?expires=1&sig=${ANY_SIG}`],
    ['a missing bucket', `/opt2/files/?expires=1&sig=${ANY_SIG}`],
    ['an empty key', `/opt2/files/content-files/?expires=1&sig=${ANY_SIG}`],
    ['an undecodable segment', `/opt2/files/content-files/%E0%A4%A?expires=1&sig=${ANY_SIG}`],
    ['a dot-dot key segment', `/opt2/files/content-files/a/../b?expires=1&sig=${ANY_SIG}`],
    ['an encoded dot-dot key segment', `/opt2/files/content-files/a/%2e%2e/b?expires=1&sig=${ANY_SIG}`],
    ['a backslash in the key', `/opt2/files/content-files/a\\b?expires=1&sig=${ANY_SIG}`],
    ['an encoded NUL in the key', `/opt2/files/content-files/a%00b?expires=1&sig=${ANY_SIG}`],
    ['a missing expires', `/opt2/files/content-files/a?sig=${ANY_SIG}`],
    ['a non-decimal expires', `/opt2/files/content-files/a?expires=-1&sig=${ANY_SIG}`],
    ['a missing signature', `/opt2/files/content-files/a?expires=1`],
    ['a short signature', `/opt2/files/content-files/a?expires=1&sig=abc`],
    ['an upper-case signature', `/opt2/files/content-files/a?expires=1&sig=${ANY_SIG.toUpperCase()}`],
  ])('reports %s as malformed', (_case, url) => {
    expect(verifySignedUrl(url, NOW_MS, HMAC_KEY)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports a well-formed URL for a bucket outside the four as unknown-bucket', () => {
    expect(verifySignedUrl(`/opt2/files/tasks/a?expires=${expires}&sig=${ANY_SIG}`, NOW_MS, HMAC_KEY)).toEqual({
      ok: false,
      reason: 'unknown-bucket',
    });
  });

  it.each<[string, (url: string) => string]>([
    ['a tampered signature', (url) => url.slice(0, -1) + (url.endsWith('0') ? '1' : '0')],
    ['a changed key', (url) => url.replace('F1_small.jpg', 'F2_small.jpg')],
    ['a changed bucket', (url) => url.replace('/content-files/', '/reporting-exports/')],
    ['an extended expiry', (url) => url.replace(`expires=${expires}`, `expires=${expires + 3600}`)],
    ['an added disposition', (url) => `${url}&disposition=attachment`],
  ])('reports %s as bad-signature', (_case, tamper) => {
    expect(verifySignedUrl(tamper(signed), NOW_MS, HMAC_KEY)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('reports a changed disposition as bad-signature', () => {
    const url = signLocalUrl({ bucket: 'content-files', key: CONTENT_KEY, expires, disposition: 'inline' }, HMAC_KEY);

    expect(verifySignedUrl(url, NOW_MS, HMAC_KEY)).toMatchObject({ ok: true, disposition: 'inline' });
    expect(verifySignedUrl(url.replace('disposition=inline', 'disposition=attachment'), NOW_MS, HMAC_KEY)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('reports a URL signed with another key as bad-signature', () => {
    expect(verifySignedUrl(signed, NOW_MS, OTHER_HMAC_KEY)).toEqual({ ok: false, reason: 'bad-signature' });
  });
});

describe('local storage HMAC key', () => {
  async function writeKeyFile(stateDir: string, text: string): Promise<void> {
    await mkdir(path.join(stateDir, 'secrets'), { recursive: true });
    await writeFile(path.join(stateDir, 'secrets', 'storage-hmac-key'), text);
  }

  it('loads <stateDir>/secrets/storage-hmac-key trimmed and signs with it when no key is given', async () => {
    const stateDir = await newStateDir();
    await writeKeyFile(stateDir, `  ${HMAC_KEY.toString('utf8')}\n`);

    expect(await loadStorageHmacKey(stateDir)).toEqual(HMAC_KEY);
    const adapter = await createLocalStorageAdapter({ stateDir, now: () => NOW_MS });
    const url = await adapter.signedUrl('content-files', CONTENT_KEY);
    expect(verifySignedUrl(url, NOW_MS, HMAC_KEY)).toMatchObject({ ok: true });
  });

  it('refuses a key file holding only whitespace', async () => {
    const stateDir = await newStateDir();
    await writeKeyFile(stateDir, ' \n\t\n');
    const file = path.join(stateDir, 'secrets', 'storage-hmac-key');

    await expect(loadStorageHmacKey(stateDir)).rejects.toThrow(`Storage HMAC key file is empty: ${file}`);
    await expect(createLocalStorageAdapter({ stateDir })).rejects.toThrow('Storage HMAC key file is empty');
  });

  it('fails when the key file is missing and no key is given', async () => {
    const stateDir = await newStateDir();

    await expect(createLocalStorageAdapter({ stateDir })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each<[string, Buffer | string]>([
    ['an empty string', ''],
    ['an empty Buffer', Buffer.alloc(0)],
  ])('refuses %s as the HMAC key', async (_case, hmacKey) => {
    const stateDir = await newStateDir();

    await expect(createLocalStorageAdapter({ stateDir, hmacKey })).rejects.toThrow('Storage HMAC key is empty');
  });

  it('accepts the HMAC key as a UTF-8 string', async () => {
    const stateDir = await newStateDir();
    const adapter = await createLocalStorageAdapter({
      stateDir,
      hmacKey: HMAC_KEY.toString('utf8'),
      now: () => NOW_MS,
    });
    const url = await adapter.signedUrl('content-files', CONTENT_KEY);

    expect(verifySignedUrl(url, NOW_MS, HMAC_KEY)).toMatchObject({ ok: true });
  });
});

interface StoredObject {
  bytes: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
  generation: number;
}

interface FakeCall {
  op: string;
  bucket: string;
  name: string;
  args: unknown[];
  generation?: number | string;
}

/** In-memory stand-in for the `Storage` client surface the cloud adapter calls; a pinned generation reads only while current. */
function fakeStorage() {
  const objects = new Map<string, StoredObject>();
  const calls: FakeCall[] = [];
  const failures = new Map<string, unknown>();
  const bucketNames: string[] = [];
  let generation = 0;

  const fileOf = (bucket: string, name: string, pinned?: number | string) => {
    const id = `${bucket}/${name}`;
    const record = (op: string, args: unknown[]): void => {
      calls.push({ op, bucket, name, args, ...(pinned === undefined ? {} : { generation: pinned }) });
      if (failures.has(op)) throw failures.get(op);
    };
    const stored = (): StoredObject => {
      const found = objects.get(id);
      if (!found || (pinned !== undefined && found.generation !== Number(pinned))) {
        throw Object.assign(new Error(`No such object: ${id}`), { code: 404 });
      }
      return found;
    };
    const file = {
      metadata: {} as { generation?: number },
      async save(bytes: Buffer, opts: { contentType: string; metadata: { metadata: Record<string, string> } }) {
        record('save', [bytes, opts]);
        objects.set(id, {
          bytes: Buffer.from(bytes),
          contentType: opts.contentType,
          metadata: { ...opts.metadata.metadata },
          generation: ++generation,
        });
      },
      createWriteStream(opts: { contentType: string }) {
        record('createWriteStream', [opts]);
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
          final(callback) {
            file.metadata.generation = ++generation;
            objects.set(id, { bytes: Buffer.concat(chunks), contentType: opts.contentType, generation });
            callback();
          },
        });
      },
      async setMetadata(md: { metadata: Record<string, string> }, opts: { ifGenerationMatch?: number }) {
        record('setMetadata', [md, opts]);
        const target = stored();
        if (opts.ifGenerationMatch !== target.generation) {
          throw Object.assign(new Error('Precondition failed'), { code: 412 });
        }
        target.metadata = { ...target.metadata, ...md.metadata };
      },
      async download() {
        record('download', []);
        return [stored().bytes];
      },
      createReadStream() {
        record('createReadStream', []);
        // Like the client, the media request goes out when the stream is first read.
        return new Readable({
          read() {
            try {
              this.push(stored().bytes);
              this.push(null);
            } catch (err) {
              this.destroy(err as Error);
            }
          },
        });
      },
      async getMetadata() {
        record('getMetadata', []);
        const found = stored();
        return [
          {
            size: String(found.bytes.length),
            contentType: found.contentType,
            metadata: found.metadata,
            generation: found.generation,
          },
        ];
      },
      async delete(opts: { ignoreNotFound?: boolean }) {
        record('delete', [opts]);
        objects.delete(id);
      },
      async getSignedUrl(cfg: Record<string, unknown>) {
        record('getSignedUrl', [cfg]);
        return [`https://storage.googleapis.com/${bucket}/${name}?X-Goog-Algorithm=GOOG4-RSA-SHA256`];
      },
    };
    return file;
  };

  const storage = {
    bucket(name: string) {
      bucketNames.push(name);
      return {
        file: (fileName: string, opts?: { generation?: number | string }) => fileOf(name, fileName, opts?.generation),
      };
    },
  };
  return { storage: storage as unknown as Storage, objects, calls, failures, bucketNames };
}

describe('Cloud Storage adapter', () => {
  const bucket: BucketName = 'finance-attachments';
  const key = `${TENANT_A.tenantId}/${FILE_ID}.pdf`;
  const pdf = Buffer.from('%PDF-1.7\ncloud attachment\n', 'utf8');

  it('signs a v4 read URL that expires 15 minutes after the injected clock', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage, now: () => NOW_MS });

    const url = await adapter.signedUrl(bucket, key);

    expect(adapter.kind).toBe('cloud');
    expect(url).toBe(`https://storage.googleapis.com/${bucket}/${key}?X-Goog-Algorithm=GOOG4-RSA-SHA256`);
    expect(fake.calls).toEqual([
      {
        op: 'getSignedUrl',
        bucket,
        name: key,
        args: [{ version: 'v4', action: 'read', expires: NOW_MS + 15 * 60 * 1000 }],
      },
    ]);
  });

  it('passes a custom lifetime and the response disposition to the signer', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage, now: () => NOW_MS });
    const disposition = 'attachment; filename="export.xlsx"';

    await adapter.signedUrl('reporting-exports', key, { expiresS: 60, disposition });

    expect(fake.calls.map((c) => c.args)).toEqual([
      [{ version: 'v4', action: 'read', expires: NOW_MS + 60_000, responseDisposition: disposition }],
    ]);
  });

  it('signs against Date.now when no clock is injected', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });
    const before = Date.now();

    await adapter.signedUrl(bucket, key);

    const after = Date.now();
    const [[cfg]] = fake.calls.map((c) => c.args) as [[{ expires: number }]];
    expect(cfg.expires).toBeGreaterThanOrEqual(before + SIGNED_URL_TTL_S * 1000);
    expect(cfg.expires).toBeLessThanOrEqual(after + SIGNED_URL_TTL_S * 1000);
  });

  it.each<[string, (bytes: Buffer) => Buffer | Uint8Array]>([
    ['a Buffer', (bytes) => bytes],
    ['a Uint8Array', (bytes) => new Uint8Array(bytes)],
  ])('uploads %s in one non-resumable save with its SHA-256 in object metadata', async (_kind, toBody) => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });

    const result = await adapter.put(bucket, key, toBody(pdf), { contentType: 'application/pdf' });

    expect(result).toEqual({ size: pdf.length, sha256: sha256Hex(pdf) });
    expect(fake.calls).toEqual([
      {
        op: 'save',
        bucket,
        name: key,
        args: [
          pdf,
          {
            resumable: false,
            contentType: 'application/pdf',
            metadata: { contentType: 'application/pdf', metadata: { sha256: sha256Hex(pdf) } },
          },
        ],
      },
    ]);
    expect(await adapter.head(bucket, key)).toEqual({
      size: pdf.length,
      sha256: sha256Hex(pdf),
      contentType: 'application/pdf',
    });
    expect(await adapter.get(bucket, key)).toEqual(pdf);
  });

  it('streams a Readable body, then records its SHA-256 on the written generation', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });
    const body = Readable.from([Buffer.from('col1,col2\n'), Buffer.from('1,2\n')]);
    const bytes = Buffer.from('col1,col2\n1,2\n');

    const result = await adapter.put('reporting-exports', key, body, { contentType: 'text/csv' });

    expect(result).toEqual({ size: bytes.length, sha256: sha256Hex(bytes) });
    expect(fake.calls.map(({ op, args }) => [op, args])).toEqual([
      ['createWriteStream', [{ resumable: false, contentType: 'text/csv', metadata: { contentType: 'text/csv' } }]],
      ['setMetadata', [{ metadata: { sha256: sha256Hex(bytes) } }, { ifGenerationMatch: 1 }]],
    ]);
    expect(await adapter.head('reporting-exports', key)).toEqual({
      size: bytes.length,
      sha256: sha256Hex(bytes),
      contentType: 'text/csv',
    });
  });

  it('defaults a missing content type and SHA-256 when reading metadata', async () => {
    const fake = fakeStorage();
    fake.objects.set(`${bucket}/${key}`, { bytes: pdf, generation: 7 });
    const adapter = createCloudStorageAdapter({ storage: fake.storage });

    expect(await adapter.head(bucket, key)).toEqual({
      size: pdf.length,
      sha256: '',
      contentType: 'application/octet-stream',
    });
  });

  it('opens the read stream only after confirming the object exists', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });
    await adapter.put(bucket, key, pdf, { contentType: 'application/pdf' });
    fake.calls.length = 0;

    expect(await readAll(await adapter.stream(bucket, key))).toEqual(pdf);
    expect(fake.calls.map((c) => c.op)).toEqual(['getMetadata', 'createReadStream']);
  });

  it('opens the head and the bytes of the generation it read, pinning the read stream to that generation', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });
    await adapter.put(bucket, key, pdf, { contentType: 'application/pdf' });
    fake.calls.length = 0;

    const opened = await adapter.open(bucket, key);

    expect(opened.head).toEqual({ size: pdf.length, sha256: sha256Hex(pdf), contentType: 'application/pdf' });
    expect(await readAll(opened.body)).toEqual(pdf);
    expect(fake.calls).toEqual([
      { op: 'getMetadata', bucket, name: key, args: [] },
      { op: 'createReadStream', bucket, name: key, args: [], generation: 1 },
    ]);
  });

  it('fails a pinned read with a 404 once a put replaces the generation it opened', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });
    const csv = Buffer.from('a,b\n1,2\n');
    await adapter.put(bucket, key, pdf, { contentType: 'application/pdf' });

    const opened = await adapter.open(bucket, key);
    await adapter.put(bucket, key, csv, { contentType: 'text/csv' });

    expect(opened.head).toEqual({ size: pdf.length, sha256: sha256Hex(pdf), contentType: 'application/pdf' });
    await expect(readAll(opened.body)).rejects.toMatchObject({ code: 404 });
    expect(await adapter.get(bucket, key)).toEqual(csv);
  });

  it('maps a 404 on open to StorageObjectNotFoundError without opening a read stream', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });

    await expect(adapter.open(bucket, key)).rejects.toMatchObject({ name: 'StorageObjectNotFoundError', bucket, key });
    expect(fake.calls.map((c) => c.op)).toEqual(['getMetadata']);
  });

  it('maps a 404 to absent: head returns null, get and stream throw StorageObjectNotFoundError', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });

    expect(await adapter.head(bucket, key)).toBeNull();
    await expect(adapter.get(bucket, key)).rejects.toMatchObject({ name: 'StorageObjectNotFoundError', bucket, key });
    await expect(adapter.stream(bucket, key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    expect(fake.calls.map((c) => c.op)).not.toContain('createReadStream');
  });

  it.each<[string, string, string, (a: StoragePort) => Promise<unknown>, unknown]>([
    ['head', 'a 403', 'getMetadata', (a) => a.head(bucket, key), Object.assign(new Error('Forbidden'), { code: 403 })],
    [
      'stream',
      'a 503',
      'getMetadata',
      (a) => a.stream(bucket, key),
      Object.assign(new Error('Backend'), { code: 503 }),
    ],
    ['open', 'a 503', 'getMetadata', (a) => a.open(bucket, key), Object.assign(new Error('Backend'), { code: 503 })],
    ['get', 'a 500', 'download', (a) => a.get(bucket, key), Object.assign(new Error('Internal'), { code: 500 })],
    ['get', 'a non-Error rejection', 'download', (a) => a.get(bucket, key), 'socket hang up'],
  ])('%s propagates %s from %s', async (_op, _failure, failingCall, run, failure) => {
    const fake = fakeStorage();
    fake.objects.set(`${bucket}/${key}`, { bytes: pdf, generation: 1 });
    fake.failures.set(failingCall, failure);
    const adapter = createCloudStorageAdapter({ storage: fake.storage });

    await expect(run(adapter)).rejects.toBe(failure);
  });

  it('deletes with ignoreNotFound, so a missing object is not an error', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });
    await adapter.put(bucket, key, pdf, { contentType: 'application/pdf' });

    await adapter.delete(bucket, key);
    await adapter.delete(bucket, key);

    expect(fake.calls.filter((c) => c.op === 'delete').map((c) => c.args)).toEqual([
      [{ ignoreNotFound: true }],
      [{ ignoreNotFound: true }],
    ]);
    expect(await adapter.head(bucket, key)).toBeNull();
  });

  it('addresses the physical bucket the mapping names, and the logical name by default', async () => {
    const mapped = fakeStorage();
    const identity = fakeStorage();
    await createCloudStorageAdapter({ storage: mapped.storage, bucketName: (b) => `opt2-plan-${b}` }).head(bucket, key);
    await createCloudStorageAdapter({ storage: identity.storage }).head(bucket, key);

    expect(mapped.bucketNames).toEqual([`opt2-plan-${bucket}`]);
    expect(identity.bucketNames).toEqual([bucket]);
  });

  it('rejects unknown buckets and unsafe keys before calling Cloud Storage', async () => {
    const fake = fakeStorage();
    const adapter = createCloudStorageAdapter({ storage: fake.storage });

    await expect(adapter.put('tasks' as BucketName, key, pdf, { contentType: 'application/pdf' })).rejects.toThrow(
      UnknownBucketError,
    );
    await expect(adapter.get(bucket, 'a/../b')).rejects.toThrow(InvalidObjectKeyError);
    await expect(adapter.signedUrl(bucket, '/abs')).rejects.toThrow(InvalidObjectKeyError);
    expect(fake.bucketNames).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('builds its own Storage client when none is injected', () => {
    expect(createCloudStorageAdapter({ projectId: 'opt2-unit' }).kind).toBe('cloud');
    expect(createCloudStorageAdapter().kind).toBe('cloud');
  });
});

describe('legacy file headers', () => {
  it.each<[string, string, string]>([
    ['ASCII unchanged', 'inline;filename="a.pdf"', 'inline;filename="a.pdf"'],
    ['a two-byte character as its UTF-8 bytes', 'ï', '\u00c3\u00af'],
    ['a three-byte character as its UTF-8 bytes', '€', '\u00e2\u0082\u00ac'],
    ['CR and LF as spaces', 'a\r\nb', 'a  b'],
    ['NUL, other C0 controls and DEL as spaces', 'a\x00b\x1fc\x7f', 'a b c '],
    ['a tab raw', 'a\tb', 'a\tb'],
  ])('legacyHeaderValue writes %s', (_case, input, expected) => {
    expect(legacyHeaderValue(input)).toBe(expected);
  });

  it('sends legacy 200 file headers with Content-Disposition stored before Content-Length', () => {
    const headers = legacyFileHeaders({ contentType: 'application/pdf', fileName: 'a.pdf', method: 'inline', size: 3 });

    expect(headers).toEqual({
      'Strict-Transport-Security': 'max-age=1200',
      Generator: 'Masa CMS 7.6.1',
      'Content-Disposition': 'inline;filename="a.pdf"',
      'Content-Length': '3',
      'Content-Type': 'application/pdf; charset=UTF-8',
    });
    const names = Object.keys(headers);
    expect(names.indexOf('Content-Disposition')).toBeLessThan(names.indexOf('Content-Length'));
  });

  it.each(['video/mp4', 'VIDEO/QuickTime', 'application/x-video'])(
    'forces attachment for the video type %s',
    (contentType) => {
      const headers = legacyFileHeaders({ contentType, fileName: 'clip.mp4', method: 'inline', size: 10 });

      expect(headers['Content-Disposition']).toBe('attachment;filename="clip.mp4"');
    },
  );

  it('echoes a non-standard method verbatim', () => {
    const headers = legacyFileHeaders({ contentType: 'image/png', fileName: 'p.png', method: 'download', size: 1 });

    expect(headers['Content-Disposition']).toBe('download;filename="p.png"');
  });

  it.each<[string, string]>([
    ['text/plain', 'text/plain; charset=UTF-8'],
    ['text/csv; charset=windows-1252', 'text/csv;charset=windows-1252'],
    ['text/html ;  charset=utf-8', 'text/html;charset=utf-8'],
    ['application/json;charset=utf-8', 'application/json;charset=utf-8'],
  ])('writes the content type %j as %j', (contentType, expected) => {
    expect(legacyFileHeaders({ contentType, fileName: 'f', method: 'inline', size: 0 })['Content-Type']).toBe(expected);
  });

  it('sends Last-Modified twice when a modification time is known, and not at all otherwise', () => {
    const withTime = legacyFileHeaders({
      contentType: 'image/png',
      fileName: 'p.png',
      method: 'inline',
      size: 1,
      lastModified: LAST_MODIFIED,
    });
    const withoutTime = legacyFileHeaders({ contentType: 'image/png', fileName: 'p.png', method: 'inline', size: 1 });

    expect(withTime['Last-Modified']).toEqual([LAST_MODIFIED_HTTP, LAST_MODIFIED_HTTP]);
    expect(withoutTime).not.toHaveProperty('Last-Modified');
  });

  it('writes a non-ASCII file name as its UTF-8 bytes', () => {
    const headers = legacyFileHeaders({
      contentType: 'application/pdf',
      fileName: 'résumé.pdf',
      method: 'inline',
      size: 1,
    });

    expect(headers['Content-Disposition']).toBe('inline;filename="r\u00c3\u00a9sum\u00c3\u00a9.pdf"');
  });
});

describe('sendLegacyFile', () => {
  const key = contentFileKey({ tenantId: TENANT_A.tenantId, fileId: FILE_ID, ext: 'pdf' });
  let app: FastifyInstance;
  let storage: LocalStorageAdapter;
  let routeError: unknown;

  beforeEach(async () => {
    storage = await createLocalStorageAdapter({ stateDir: await newStateDir(), hmacKey: HMAC_KEY });
    routeError = undefined;
    app = fastify();
    app.get('/_api/render/file/', async (request, reply) => {
      const query = request.query as { key: string; fileName?: string };
      return sendLegacyFile(reply, {
        storage,
        bucket: 'content-files',
        key: query.key,
        contentType: 'application/pdf',
        fileName: query.fileName ?? 'a.pdf',
        method: 'inline',
        lastModified: LAST_MODIFIED,
      });
    });
    app.setErrorHandler((err, _request, reply) => {
      routeError = err;
      return reply.code(404).send('');
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers 200 with the stored bytes and the legacy file headers', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x00]);
    await storage.put('content-files', key, bytes, { contentType: 'application/pdf' });

    const res = await app.inject({ method: 'GET', url: '/_api/render/file/', query: { key } });

    expect(routeError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(bytes);
    expect(res.headers).toMatchObject({
      'content-type': 'application/pdf; charset=UTF-8',
      'content-length': '3',
      'content-disposition': 'inline;filename="a.pdf"',
      generator: 'Masa CMS 7.6.1',
      'strict-transport-security': 'max-age=1200',
      'last-modified': [LAST_MODIFIED_HTTP, LAST_MODIFIED_HTTP],
    });
  });

  // streamFile's 304 branch never runs on ACF 2023, which never exposes cgi.http_if_modified_since,
  // so legacy answers 200 with the full body whatever the header says; a 304 here would break parity.
  it.each<[string, string]>([
    ['a later date', 'Mon, 02 Jun 2025 08:30:00 GMT'],
    ['the Last-Modified date', LAST_MODIFIED_HTTP],
    ['an earlier date', 'Sat, 31 May 2025 08:30:00 GMT'],
  ])('answers 200 with the full body when If-Modified-Since is %s', async (_case, ifModifiedSince) => {
    const bytes = Buffer.from('%PDF-1.7\nconditional\n');
    await storage.put('content-files', key, bytes, { contentType: 'application/pdf' });

    const res = await app.inject({
      method: 'GET',
      url: '/_api/render/file/',
      query: { key },
      headers: { 'if-modified-since': ifModifiedSince },
    });

    expect(routeError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(bytes);
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.headers['last-modified']).toEqual([LAST_MODIFIED_HTTP, LAST_MODIFIED_HTTP]);
  });

  it('writes a non-ASCII file name to the socket as its UTF-8 bytes', async () => {
    const bytes = Buffer.from('%PDF');
    await storage.put('content-files', key, bytes, { contentType: 'application/pdf' });
    const { port } = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));

    const raw = await rawHttpGet(
      Number(port),
      `/_api/render/file/?key=${encodeURIComponent(key)}&fileName=${encodeURIComponent('résumé.pdf')}`,
    );

    const headEnd = raw.indexOf('\r\n\r\n');
    const disposition = raw
      .subarray(0, headEnd)
      .toString('latin1')
      .split('\r\n')
      .find((line) => line.toLowerCase().startsWith('content-disposition:'));
    expect(raw.subarray(0, raw.indexOf('\r\n')).toString('latin1')).toBe('HTTP/1.1 200 OK');
    expect(Buffer.from(disposition ?? '', 'latin1')).toEqual(
      Buffer.from('content-disposition: inline;filename="résumé.pdf"', 'utf8'),
    );
    expect(raw.subarray(headEnd + 4)).toEqual(bytes);
  });

  it('sends the Content-Length of the version it streams when a put replaces the object right after open', async () => {
    const old = Buffer.alloc(64 * 1024, 0x25);
    const replacement = Buffer.from('%PDF-1.7\nreplacement\n');
    await storage.put('content-files', key, old, { contentType: 'application/pdf' });
    const open = storage.open.bind(storage);
    vi.spyOn(storage, 'open').mockImplementationOnce(async (bucket, k) => {
      const opened = await open(bucket, k);
      await storage.put(bucket, k, replacement, { contentType: 'application/pdf' });
      return opened;
    });

    const res = await app.inject({ method: 'GET', url: '/_api/render/file/', query: { key } });

    expect(routeError).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(old.length));
    expect(res.rawPayload).toEqual(old);
    expect(await storage.get('content-files', key)).toEqual(replacement);
  });

  it('rejects a missing object with StorageObjectNotFoundError before any legacy header is set', async () => {
    const res = await app.inject({ method: 'GET', url: '/_api/render/file/', query: { key } });

    expect(routeError).toBeInstanceOf(StorageObjectNotFoundError);
    expect(routeError).toMatchObject({ bucket: 'content-files', key });
    expect(res.statusCode).toBe(404);
    expect(res.headers).not.toHaveProperty('generator');
    expect(res.headers).not.toHaveProperty('content-disposition');
    expect(res.headers).not.toHaveProperty('last-modified');
  });
});
