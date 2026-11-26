import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Storage, type File, type FileMetadata, type FileOptions } from '@google-cloud/storage';
import { boundedReadStream, boundedWriteStream, withinStorageDeadline, type StorageWaitTarget } from './deadline.js';
import {
  assertBucket,
  assertObjectKey,
  SHA256_METADATA_KEY,
  SIGNED_URL_TTL_S,
  STORAGE_TIMEOUT_MS,
  StorageObjectNotFoundError,
  type BucketName,
  type ObjectHead,
  type StoragePort,
} from './port.js';

/** Cloud adapter options: `storage` injects a client, `bucketName` maps a logical bucket to its physical name (identity by default), `now` returns epoch ms, `timeoutMs` replaces `STORAGE_TIMEOUT_MS` in tests. */
export interface CloudStorageOptions {
  projectId?: string;
  storage?: Storage;
  bucketName?: (b: BucketName) => string;
  now?: () => number;
  timeoutMs?: number;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 404;
}

async function metadataOf(file: File, target: StorageWaitTarget): Promise<FileMetadata | null> {
  try {
    const [md] = await withinStorageDeadline(target, () => file.getMetadata());
    return md;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function headFrom(md: FileMetadata): ObjectHead {
  return {
    size: Number(md.size),
    sha256: String(md.metadata?.[SHA256_METADATA_KEY] ?? ''),
    contentType: md.contentType ?? 'application/octet-stream',
  };
}

async function headOf(file: File, target: StorageWaitTarget): Promise<ObjectHead | null> {
  const md = await metadataOf(file, target);
  return md === null ? null : headFrom(md);
}

/** Creates the Cloud Storage `StoragePort`, authenticated by Application Default Credentials. */
export function createCloudStorageAdapter(opts: CloudStorageOptions = {}): StoragePort {
  const timeoutMs = opts.timeoutMs ?? STORAGE_TIMEOUT_MS;
  const storage =
    opts.storage ?? new Storage({ projectId: opts.projectId, retryOptions: { totalTimeout: Math.ceil(timeoutMs / 1000) } });
  const bucketName = opts.bucketName ?? ((b: BucketName) => b);
  const now = opts.now ?? Date.now;
  const targetOf = (operation: StorageWaitTarget['operation'], bucket: string, key: string): StorageWaitTarget => ({
    operation,
    bucket,
    key,
    timeoutMs,
  });

  const fileOf = (bucket: BucketName, key: string, fileOpts?: FileOptions): File => {
    const logical = assertBucket(bucket);
    const name = assertObjectKey(key);
    return storage.bucket(bucketName(logical)).file(name, fileOpts);
  };

  return {
    kind: 'cloud',

    async put(bucket, key, body, { contentType }) {
      const file = fileOf(bucket, key);
      const target = targetOf('put', bucket, key);
      if (body instanceof Uint8Array) {
        const bytes = Buffer.from(body);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await withinStorageDeadline(target, () =>
          file.save(bytes, {
            resumable: false,
            contentType,
            metadata: { contentType, metadata: { [SHA256_METADATA_KEY]: sha256 } },
          }),
        );
        return { size: bytes.length, sha256 };
      }

      const hash = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          size += chunk.length;
          callback(null, chunk);
        },
      });
      await pipeline(
        body,
        meter,
        boundedWriteStream(target, file.createWriteStream({ resumable: false, contentType, metadata: { contentType } })),
      );
      const sha256 = hash.digest('hex');
      await withinStorageDeadline(target, () =>
        file.setMetadata({ metadata: { [SHA256_METADATA_KEY]: sha256 } }, { ifGenerationMatch: file.metadata.generation }),
      );
      return { size, sha256 };
    },

    async get(bucket, key) {
      const file = fileOf(bucket, key);
      try {
        const [buf] = await withinStorageDeadline(targetOf('get', bucket, key), () => file.download());
        return buf;
      } catch (err) {
        if (isNotFound(err)) throw new StorageObjectNotFoundError(bucket, key);
        throw err;
      }
    },

    async stream(bucket, key) {
      const file = fileOf(bucket, key);
      const target = targetOf('stream', bucket, key);
      if ((await headOf(file, target)) === null) throw new StorageObjectNotFoundError(bucket, key);
      return boundedReadStream(target, file.createReadStream());
    },

    async open(bucket, key) {
      const target = targetOf('open', bucket, key);
      const md = await metadataOf(fileOf(bucket, key), target);
      if (md === null) throw new StorageObjectNotFoundError(bucket, key);
      // Pinned to the generation `head` describes; once replaced it reads as 404, as buckets keep no old versions.
      const body = boundedReadStream(target, fileOf(bucket, key, { generation: md.generation }).createReadStream());
      return { head: headFrom(md), body };
    },

    async delete(bucket, key) {
      const file = fileOf(bucket, key);
      await withinStorageDeadline(targetOf('delete', bucket, key), () => file.delete({ ignoreNotFound: true }));
    },

    async head(bucket, key) {
      return headOf(fileOf(bucket, key), targetOf('head', bucket, key));
    },

    async signedUrl(bucket, key, { expiresS = SIGNED_URL_TTL_S, disposition } = {}) {
      const file = fileOf(bucket, key);
      // Credentials without a private key make the library sign through the IAM Credentials signBlob API.
      const [url] = await withinStorageDeadline(targetOf('signedUrl', bucket, key), () =>
        file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: now() + expiresS * 1000,
          ...(disposition ? { responseDisposition: disposition } : {}),
        }),
      );
      return url;
    },
  };
}
