import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Storage, type File } from '@google-cloud/storage';
import {
  assertBucket,
  assertObjectKey,
  SHA256_METADATA_KEY,
  SIGNED_URL_TTL_S,
  StorageObjectNotFoundError,
  type BucketName,
  type ObjectHead,
  type StoragePort,
} from './port.js';

/** Cloud adapter options: `storage` injects a client, `bucketName` maps a logical bucket to its physical name (identity by default), `now` returns epoch ms. */
export interface CloudStorageOptions {
  projectId?: string;
  storage?: Storage;
  bucketName?: (b: BucketName) => string;
  now?: () => number;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 404;
}

async function headOf(file: File): Promise<ObjectHead | null> {
  try {
    const [md] = await file.getMetadata();
    return {
      size: Number(md.size),
      sha256: String(md.metadata?.[SHA256_METADATA_KEY] ?? ''),
      contentType: md.contentType ?? 'application/octet-stream',
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Creates the Cloud Storage `StoragePort`, authenticated by Application Default Credentials. */
export function createCloudStorageAdapter(opts: CloudStorageOptions = {}): StoragePort {
  const storage = opts.storage ?? new Storage({ projectId: opts.projectId });
  const bucketName = opts.bucketName ?? ((b: BucketName) => b);
  const now = opts.now ?? Date.now;

  const fileOf = (bucket: BucketName, key: string): File => {
    const logical = assertBucket(bucket);
    const name = assertObjectKey(key);
    return storage.bucket(bucketName(logical)).file(name);
  };

  return {
    kind: 'cloud',

    async put(bucket, key, body, { contentType }) {
      const file = fileOf(bucket, key);
      if (body instanceof Uint8Array) {
        const bytes = Buffer.from(body);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await file.save(bytes, {
          resumable: false,
          contentType,
          metadata: { contentType, metadata: { [SHA256_METADATA_KEY]: sha256 } },
        });
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
      await pipeline(body, meter, file.createWriteStream({ resumable: false, contentType, metadata: { contentType } }));
      const sha256 = hash.digest('hex');
      await file.setMetadata(
        { metadata: { [SHA256_METADATA_KEY]: sha256 } },
        { ifGenerationMatch: file.metadata.generation },
      );
      return { size, sha256 };
    },

    async get(bucket, key) {
      const file = fileOf(bucket, key);
      try {
        const [buf] = await file.download();
        return buf;
      } catch (err) {
        if (isNotFound(err)) throw new StorageObjectNotFoundError(bucket, key);
        throw err;
      }
    },

    async stream(bucket, key) {
      const file = fileOf(bucket, key);
      if ((await headOf(file)) === null) throw new StorageObjectNotFoundError(bucket, key);
      return file.createReadStream();
    },

    async delete(bucket, key) {
      await fileOf(bucket, key).delete({ ignoreNotFound: true });
    },

    async head(bucket, key) {
      return headOf(fileOf(bucket, key));
    },

    async signedUrl(bucket, key, { expiresS = SIGNED_URL_TTL_S, disposition } = {}) {
      // Credentials without a private key make the library sign through the IAM Credentials signBlob API.
      const [url] = await fileOf(bucket, key).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: now() + expiresS * 1000,
        ...(disposition ? { responseDisposition: disposition } : {}),
      });
      return url;
    },
  };
}
