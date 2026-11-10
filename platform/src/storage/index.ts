/** Public surface of `@opt2/platform/storage`; the Cloud Storage adapter is exported as a type only, so importing this never loads `@google-cloud/storage`. */
export {
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
} from './port.js';
export type {
  BucketName,
  PutBody,
  PutOptions,
  PutResult,
  ObjectHead,
  SignedUrlOptions,
  StoragePort,
  StorageEnv,
  CreateStoragePortOptions,
  ContentFileVariant,
} from './port.js';
export { createLocalStorageAdapter, loadStorageHmacKey, signLocalUrl, verifySignedUrl } from './local-adapter.js';
export type { LocalStorageAdapter, LocalStorageOptions, LocalUrlVerification } from './local-adapter.js';
export type { CloudStorageOptions } from './cloud-adapter.js';
export { sendLegacyFile, legacyFileHeaders, legacyHeaderValue } from './legacy-stream.js';
export type { LegacyFileOptions } from './legacy-stream.js';
