import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
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
  type PutBody,
  type PutResult,
  type StoragePort,
} from './port.js';

/** Directory under the state directory that holds every bucket. */
export const STORAGE_DIR = 'storage';

/** Directory under `STORAGE_DIR` holding `<bucket>/<key>.json` metadata, kept apart from the object bytes. */
export const META_DIR = '.meta';

const SECRETS_DIR = 'secrets';
const HMAC_KEY_FILE = 'storage-hmac-key';
const URL_BASE = 'http://opt2.local';
const SIG_HEX = /^[0-9a-f]{64}$/;
const DECIMAL = /^\d+$/;

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
  const metaPath = (bucket: BucketName, key: string): string =>
    `${path.join(root, META_DIR, assertBucket(bucket), ...assertObjectKey(key).split('/'))}.json`;

  return {
    kind: 'local',

    async put(bucket, key, body, putOpts) {
      const file = objectPath(bucket, key);
      const meta = metaPath(bucket, key);
      await Promise.all([mkdir(path.dirname(file), { recursive: true }), mkdir(path.dirname(meta), { recursive: true })]);
      const suffix = randomBytes(8).toString('hex');
      const fileTmp = partialPath(file, suffix);
      const metaTmp = partialPath(meta, suffix);
      try {
        const { size, sha256 } = await writeHashed(body, fileTmp);
        await writeFile(metaTmp, JSON.stringify({ contentType: putOpts.contentType, sha256, size }));
        await rename(fileTmp, file);
        await rename(metaTmp, meta);
        return { size, sha256 };
      } catch (err) {
        // Cleanup is best effort: the write error is the one worth reporting.
        await Promise.all([rm(fileTmp, { force: true }), rm(metaTmp, { force: true })]).catch(() => undefined);
        throw err;
      }
    },

    async head(bucket, key) {
      const meta = metaPath(bucket, key);
      let text: string;
      try {
        text = await readFile(meta, 'utf8');
      } catch (err) {
        if (isAbsent(err)) return null;
        throw err;
      }
      const m = JSON.parse(text) as ObjectHead;
      return { size: m.size, sha256: m.sha256, contentType: m.contentType };
    },

    async get(bucket, key) {
      const file = objectPath(bucket, key);
      try {
        return await readFile(file);
      } catch (err) {
        throw isAbsent(err) ? new StorageObjectNotFoundError(bucket, key) : err;
      }
    },

    async stream(bucket, key) {
      const file = objectPath(bucket, key);
      try {
        await stat(file);
      } catch (err) {
        throw isAbsent(err) ? new StorageObjectNotFoundError(bucket, key) : err;
      }
      return createReadStream(file);
    },

    async delete(bucket, key) {
      await Promise.all([rm(objectPath(bucket, key), { force: true }), rm(metaPath(bucket, key), { force: true })]);
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

/** Streams `body` into `file`, hashing and counting the bytes as they pass. */
async function writeHashed(body: PutBody, file: string): Promise<PutResult> {
  const hash = createHash('sha256');
  let size = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  const source = ArrayBuffer.isView(body) ? Readable.from([body]) : body;
  await pipeline(source, hasher, createWriteStream(file));
  return { size, sha256: hash.digest('hex') };
}

/** Whether a filesystem error means the path, or one of its parents, does not exist. */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
