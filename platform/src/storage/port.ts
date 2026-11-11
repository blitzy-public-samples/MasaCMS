import type { Readable } from 'node:stream';
import { cfUuid, isCfUuid } from '../legacy-compat/index.js';

/** Logical buckets; each is written only by the service that owns it. */
export const BUCKETS = ['content-files', 'reporting-exports', 'finance-attachments', 'esignature-documents'] as const;

/** One of the four logical buckets. */
export type BucketName = (typeof BUCKETS)[number];

/** Default lifetime of a signed download URL, in seconds (15 minutes). */
export const SIGNED_URL_TTL_S = 900;

/** Path prefix of local HMAC-signed URLs; the gateway routes it to the bucket's owner. */
export const LOCAL_SIGNED_URL_PREFIX = '/opt2/files/';

/** Object metadata key holding the lowercase hex SHA-256 of the stored bytes. */
export const SHA256_METADATA_KEY = 'sha256';

/** Object bytes accepted by `put`. */
export type PutBody = Buffer | Uint8Array | Readable;

/** Content type stored with the object. */
export interface PutOptions {
  contentType: string;
}

/** Byte size and lowercase hex SHA-256 computed while writing. */
export interface PutResult {
  size: number;
  sha256: string;
}

/** Stored object metadata, read without touching the bytes. */
export interface ObjectHead {
  size: number;
  sha256: string;
  contentType: string;
}

/** Object metadata with a read stream of that same stored version. */
export interface OpenedObject {
  head: ObjectHead;
  body: Readable;
}

/** `expiresS` defaults to `SIGNED_URL_TTL_S`; `disposition` is the download's Content-Disposition. */
export interface SignedUrlOptions {
  expiresS?: number;
  disposition?: string;
}

/** Object storage port implemented by the local and Cloud Storage adapters. */
export interface StoragePort {
  readonly kind: 'local' | 'cloud';
  /** Stores the object, replacing any previous version. */
  put(bucket: BucketName, key: string, body: PutBody, opts: PutOptions): Promise<PutResult>;
  /** Reads the whole object; throws `StorageObjectNotFoundError` when it is absent. */
  get(bucket: BucketName, key: string): Promise<Buffer>;
  /** Opens a read stream; throws `StorageObjectNotFoundError` when the object is absent. */
  stream(bucket: BucketName, key: string): Promise<Readable>;
  /** Opens a read stream together with the metadata of the version it reads; throws `StorageObjectNotFoundError` when the object is absent. */
  open(bucket: BucketName, key: string): Promise<OpenedObject>;
  /** Deletes the object; a missing object is not an error. */
  delete(bucket: BucketName, key: string): Promise<void>;
  /** Returns the stored metadata, or `null` when the object is absent. */
  head(bucket: BucketName, key: string): Promise<ObjectHead | null>;
  /** Returns a time-limited download URL for the object. */
  signedUrl(bucket: BucketName, key: string, opts?: SignedUrlOptions): Promise<string>;
}

/** Variables the storage factory reads; a structural subset of the service-kit env. */
export interface StorageEnv {
  OPT2_STORAGE_ADAPTER: 'local' | 'cloud';
  OPT2_STATE_DIR?: string;
  GOOGLE_CLOUD_PROJECT?: string;
}

/** `now` returns epoch ms; `hmacKey` replaces the local adapter's key file. */
export interface CreateStoragePortOptions {
  now?: () => number;
  hmacKey?: Buffer | string;
}

/** Raised when an object that must exist is absent. */
export class StorageObjectNotFoundError extends Error {
  override readonly name = 'StorageObjectNotFoundError';

  constructor(
    readonly bucket: string,
    readonly key: string,
  ) {
    super(`Storage object not found: ${bucket}/${key}`);
  }
}

/** Raised for a bucket name outside `BUCKETS`. */
export class UnknownBucketError extends Error {
  override readonly name = 'UnknownBucketError';

  constructor(readonly bucket: string) {
    super(`Unknown storage bucket: ${JSON.stringify(bucket)}`);
  }
}

/** Raised for an object key, or key part, that breaks the key conventions. */
export class InvalidObjectKeyError extends Error {
  override readonly name = 'InvalidObjectKeyError';

  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`Invalid object key ${JSON.stringify(key)}: ${reason}`);
  }
}

/** Whether `v` names one of the four buckets. */
export function isBucketName(v: string): v is BucketName {
  return (BUCKETS as readonly string[]).includes(v);
}

/** Returns `v` as a bucket name; throws `UnknownBucketError` otherwise. */
export function assertBucket(v: string): BucketName {
  if (!isBucketName(v)) throw new UnknownBucketError(v);
  return v;
}

/** Returns `key` when it is a relative `/`-separated path that cannot leave its bucket; throws `InvalidObjectKeyError` otherwise. */
export function assertObjectKey(key: string): string {
  const badSegment = key.split('/').some((s) => s === '' || s === '.' || s === '..');
  if (badSegment || key.includes('\\') || key.includes('\0')) {
    throw new InvalidObjectKeyError(key, 'expected a relative path without empty, "." or ".." segments, backslash or NUL');
  }
  return key;
}

/** Rendition suffix of a content file: none, `_source`, `_small`, `_medium`, or an on-demand `_<size name>` or `_W<w>_H<h>`. */
export type ContentFileVariant = '' | '_source' | '_small' | '_medium' | `_${string}`;

const CONTENT_FILE_VARIANT = /^_[^/\\\u0000-\u001F\u007F]+$/;

/** `content-files` key `<tenantId>/<fileId><variant>.<ext>` with a lower-cased extension; pooled files take the umbrella tenant's id. */
export function contentFileKey(p: { tenantId: string; fileId: string; variant?: ContentFileVariant; ext: string }): string {
  const variant = p.variant ?? '';
  if (variant !== '' && !CONTENT_FILE_VARIANT.test(variant)) {
    throw new InvalidObjectKeyError(variant, 'variant must be empty or "_" followed by characters other than "/", "\\" and control characters');
  }
  return `${p.tenantId}/${p.fileId}${variant}.${p.ext.toLowerCase()}`;
}

/** Key `<tenantId>/<id>.<ext>` for the export, attachment and document buckets; `id` must be a CF-format UUID and defaults to a new one. */
export function objectKey(p: { tenantId: string; id?: string; ext: string }): string {
  if (p.id !== undefined && !isCfUuid(p.id)) {
    throw new InvalidObjectKeyError(p.id, 'id must be a CF-format UUID');
  }
  return `${p.tenantId}/${p.id ?? cfUuid()}.${p.ext}`;
}

// Non-literal specifiers keep the port free of any compile-time dependency on its adapters, which depend on it;
// each adapter module must export the factory shape declared below.
const LOCAL_ADAPTER_MODULE = './local-adapter.js';
const CLOUD_ADAPTER_MODULE = './cloud-adapter.js';

interface LocalAdapterModule {
  createLocalStorageAdapter: (opts: { stateDir: string; hmacKey?: Buffer | string; now?: () => number }) => Promise<StoragePort>;
}

interface CloudAdapterModule {
  createCloudStorageAdapter: (opts: { projectId?: string; now?: () => number }) => StoragePort;
}

/** Creates the adapter `OPT2_STORAGE_ADAPTER` selects, loading only that adapter's module. */
export async function createStoragePort(env: StorageEnv, opts: CreateStoragePortOptions = {}): Promise<StoragePort> {
  if (env.OPT2_STORAGE_ADAPTER === 'local') {
    if (!env.OPT2_STATE_DIR) throw new Error('OPT2_STATE_DIR is required for the local storage adapter');
    const { createLocalStorageAdapter } = (await import(LOCAL_ADAPTER_MODULE)) as LocalAdapterModule;
    return createLocalStorageAdapter({ stateDir: env.OPT2_STATE_DIR, hmacKey: opts.hmacKey, now: opts.now });
  }
  const { createCloudStorageAdapter } = (await import(CLOUD_ADAPTER_MODULE)) as CloudAdapterModule;
  return createCloudStorageAdapter({ projectId: env.GOOGLE_CLOUD_PROJECT, now: opts.now });
}
