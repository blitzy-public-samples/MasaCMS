import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import {
  LOCAL_SIGNED_URL_PREFIX,
  SIGNED_URL_TTL_S,
  StorageObjectNotFoundError,
  assertBucket,
  assertObjectKey,
  isBucketName,
  type BucketName,
  type ObjectHead,
  type OpenedObject,
  type PutBody,
  type PutResult,
  type StoragePort,
} from './port.js';

/** Directory under the state directory that holds every bucket. */
export const STORAGE_DIR = 'storage';

const SECRETS_DIR = 'secrets';
const HMAC_KEY_FILE = 'storage-hmac-key';
const URL_BASE = 'http://opt2.local';
const SIG_HEX = /^[0-9a-f]{64}$/;
const DECIMAL = /^\d+$/;
const TRAILER_MARKER = Buffer.from('OPT2OBJ1', 'latin1');
const TRAILER_FIXED_BYTES = 4 + TRAILER_MARKER.length;

/** `now` returns epoch ms; `hmacKey` replaces the key file `<stateDir>/secrets/storage-hmac-key`. */
export interface LocalStorageOptions {
  stateDir: string;
  hmacKey?: Buffer | string;
  now?: () => number;
}

/** Outcome of checking a local signed URL; `expires` is epoch seconds. */
export type LocalUrlVerification =
  | { ok: true; bucket: BucketName; key: string; expires: number; disposition?: string }
  | { ok: false; reason: 'malformed' | 'unknown-bucket' | 'bad-signature' | 'expired' };

/** Disk-backed storage port that also verifies the URLs it signs. */
export interface LocalStorageAdapter extends StoragePort {
  readonly kind: 'local';
  /** Checks a URL issued by `signedUrl`; `now` is epoch ms and defaults to the adapter's clock. */
  verifySignedUrl(url: string, now?: number): LocalUrlVerification;
}

/** Reads `<stateDir>/secrets/storage-hmac-key`, trimmed, as UTF-8 bytes; throws when it is empty. */
export async function loadStorageHmacKey(stateDir: string): Promise<Buffer> {
  const file = path.join(stateDir, SECRETS_DIR, HMAC_KEY_FILE);
  const text = (await readFile(file, 'utf8')).trim();
  if (text === '') throw new Error(`Storage HMAC key file is empty: ${file}`);
  return Buffer.from(text, 'utf8');
}

/** Creates the local adapter, storing objects under `<stateDir>/storage`. */
export async function createLocalStorageAdapter(opts: LocalStorageOptions): Promise<LocalStorageAdapter> {
  const now = opts.now ?? Date.now;
  const hmacKey =
    typeof opts.hmacKey === 'string'
      ? Buffer.from(opts.hmacKey, 'utf8')
      : (opts.hmacKey ?? (await loadStorageHmacKey(opts.stateDir)));
  // An empty key would let anyone forge download URLs.
  if (hmacKey.length === 0) throw new Error('Storage HMAC key is empty');

  const root = path.join(opts.stateDir, STORAGE_DIR);
  const objectPath = (bucket: BucketName, key: string): string =>
    path.join(root, assertBucket(bucket), ...assertObjectKey(key).split('/'));
  const openPayload = async (bucket: BucketName, key: string): Promise<OpenedObject> => {
    const opened = await openObject(objectPath(bucket, key), bucket, key);
    if (opened === null) throw new StorageObjectNotFoundError(bucket, key);
    const { handle, head } = opened;
    if (head.size === 0) {
      await handle.close();
      return { head, body: Readable.from([], { objectMode: false }) };
    }
    return { head, body: handle.createReadStream({ start: 0, end: head.size - 1 }) };
  };

  return {
    kind: 'local',

    async put(bucket, key, body, putOpts) {
      const file = objectPath(bucket, key);
      await mkdir(path.dirname(file), { recursive: true });
      const partial = partialPath(file, randomBytes(8).toString('hex'));
      try {
        const result = await writeObject(body, putOpts.contentType, partial);
        await rename(partial, file);
        return result;
      } catch (err) {
        // Cleanup is best effort: the write error is the one worth reporting.
        await rm(partial, { force: true }).catch(() => undefined);
        throw err;
      }
    },

    async head(bucket, key) {
      const opened = await openObject(objectPath(bucket, key), bucket, key);
      if (opened === null) return null;
      await opened.handle.close();
      return opened.head;
    },

    async get(bucket, key) {
      return buffer((await openPayload(bucket, key)).body);
    },

    async stream(bucket, key) {
      return (await openPayload(bucket, key)).body;
    },

    open: openPayload,

    async delete(bucket, key) {
      await rm(objectPath(bucket, key), { force: true });
    },

    async signedUrl(bucket, key, signOpts = {}) {
      const expires = Math.floor(now() / 1000) + (signOpts.expiresS ?? SIGNED_URL_TTL_S);
      return signLocalUrl(
        { bucket: assertBucket(bucket), key: assertObjectKey(key), expires, disposition: signOpts.disposition },
        hmacKey,
      );
    },

    verifySignedUrl: (url: string, at: number = now()) => verifySignedUrl(url, at, hmacKey),
  };
}

/** Builds the path-only URL `/opt2/files/<bucket>/<key>?expires=<s>&sig=<hex>[&disposition=<d>]`; `expires` is epoch seconds. */
export function signLocalUrl(
  p: { bucket: BucketName; key: string; expires: number; disposition?: string },
  hmacKey: Buffer,
): string {
  const sig = mac(p.bucket, p.key, String(p.expires), p.disposition, hmacKey).toString('hex');
  const encodedKey = p.key.split('/').map(encodeURIComponent).join('/');
  const url = `${LOCAL_SIGNED_URL_PREFIX}${p.bucket}/${encodedKey}?expires=${p.expires}&sig=${sig}`;
  return p.disposition === undefined ? url : `${url}&disposition=${encodeURIComponent(p.disposition)}`;
}

/** Checks an absolute or path-only local signed URL without throwing; `now` is epoch ms or a Date. */
export function verifySignedUrl(url: string, now: number | Date, hmacKey: Buffer): LocalUrlVerification {
  let query: URLSearchParams;
  try {
    query = new URL(url, URL_BASE).searchParams;
  } catch {
    return reject('malformed');
  }
  // Segments come from the URL as written: WHATWG parsing would collapse `..`/`%2e%2e` and turn `\` into `/`,
  // re-addressing a traversal attempt to another key instead of rejecting it.
  const rawPath = rawPathOf(url);
  if (!rawPath.startsWith(LOCAL_SIGNED_URL_PREFIX)) return reject('malformed');
  let bucket: string;
  let key: string;
  try {
    const [first = '', ...rest] = rawPath.slice(LOCAL_SIGNED_URL_PREFIX.length).split('/').map(decodeURIComponent);
    bucket = assertObjectKey(first);
    key = assertObjectKey(rest.join('/'));
  } catch {
    return reject('malformed');
  }
  const expires = query.get('expires') ?? '';
  const sig = query.get('sig') ?? '';
  if (!DECIMAL.test(expires) || !SIG_HEX.test(sig)) return reject('malformed');
  if (!isBucketName(bucket)) return reject('unknown-bucket');
  const disposition = query.get('disposition') ?? undefined;
  if (!timingSafeEqual(mac(bucket, key, expires, disposition, hmacKey), Buffer.from(sig, 'hex'))) {
    return reject('bad-signature');
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (Math.floor(nowMs / 1000) > Number(expires)) return reject('expired');
  const ok = { ok: true as const, bucket, key, expires: Number(expires) };
  return disposition === undefined ? ok : { ...ok, disposition };
}

/** HMAC-SHA256 over `<bucket>/<key>\n<expires>`, plus `\n<disposition>` when one is given. */
function mac(bucket: string, key: string, expires: string, disposition: string | undefined, hmacKey: Buffer): Buffer {
  const signed = `${bucket}/${key}\n${expires}${disposition === undefined ? '' : `\n${disposition}`}`;
  return createHmac('sha256', hmacKey).update(signed, 'utf8').digest();
}

function reject(reason: 'malformed' | 'unknown-bucket' | 'bad-signature' | 'expired'): LocalUrlVerification {
  return { ok: false, reason };
}

/** Path part of `url` exactly as written, without scheme, authority, query or fragment. */
function rawPathOf(url: string): string {
  const rest = url.replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i, '');
  return rest.slice(0, rest.search(/[?#]|$/));
}

/** Hidden sibling `.<basename>.<suffix>.partial`, on the same filesystem as `file` so the rename is atomic. */
function partialPath(file: string, suffix: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${suffix}.partial`);
}

/** Streams `body` then its trailer into `file`, hashing and counting the payload as it passes; syncs before closing. */
async function writeObject(body: PutBody, contentType: string, file: string): Promise<PutResult> {
  const hash = createHash('sha256');
  let size = 0;
  let sha256 = '';
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      sha256 = hash.digest('hex');
      callback(null, encodeTrailer(contentType, sha256));
    },
  });
  const source = ArrayBuffer.isView(body) ? Readable.from([body]) : body;
  await pipeline(source, hasher, createWriteStream(file, { flush: true }));
  return { size, sha256 };
}

/** Object file suffix: UTF-8 JSON `{contentType, sha256}`, its byte length as uint32 BE, then `TRAILER_MARKER`. */
function encodeTrailer(contentType: string, sha256: string): Buffer {
  const json = Buffer.from(JSON.stringify({ contentType, sha256 }), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([json, length, TRAILER_MARKER]);
}

/** Opens `file` and reads its trailer; `null` when it is absent or not a regular file. The caller closes `handle`. */
async function openObject(
  file: string,
  bucket: BucketName,
  key: string,
): Promise<{ handle: FileHandle; head: ObjectHead } | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (err) {
    if (isAbsent(err)) return null;
    throw err;
  }
  let head: ObjectHead | null = null;
  try {
    const stats = await handle.stat();
    if (stats.isFile()) head = await readTrailer(handle, stats.size, bucket, key);
  } finally {
    if (head === null) await handle.close();
  }
  return head === null ? null : { handle, head };
}

/** Metadata from the trailer of an object file of `fileSize` bytes; `size` is the payload length before it. */
async function readTrailer(handle: FileHandle, fileSize: number, bucket: BucketName, key: string): Promise<ObjectHead> {
  const invalid = new Error(`Storage object has no valid trailer: ${bucket}/${key}`);
  if (fileSize < TRAILER_FIXED_BYTES) throw invalid;
  const fixed = await readAt(handle, fileSize - TRAILER_FIXED_BYTES, TRAILER_FIXED_BYTES);
  const jsonLength = fixed.readUInt32BE(0);
  const size = fileSize - TRAILER_FIXED_BYTES - jsonLength;
  if (!fixed.subarray(4).equals(TRAILER_MARKER) || size < 0) throw invalid;
  const json = (await readAt(handle, size, jsonLength)).toString('utf8');
  let meta: Partial<Record<keyof ObjectHead, unknown>> | null;
  try {
    meta = JSON.parse(json) as typeof meta;
  } catch {
    throw invalid;
  }
  if (typeof meta?.contentType !== 'string' || typeof meta.sha256 !== 'string') throw invalid;
  return { size, sha256: meta.sha256, contentType: meta.contentType };
}

/** `length` bytes of the file at `position`, zero-filled past its end, leaving the file offset unchanged. */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  await handle.read(bytes, 0, length, position);
  return bytes;
}

/** Whether a filesystem error means the path, or one of its parents, does not exist. */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
