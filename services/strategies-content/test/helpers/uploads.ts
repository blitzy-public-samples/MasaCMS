/** Posted file parts for suites and fixtures that call the domain without a multipart request. */
import { Readable } from 'node:stream';
import { sha256Hex } from '@opt2/platform/migration-kit';
import type { UploadedFile } from '../../src/domain/files.js';

/** The part fields an {@link uploadedFile} carries beside its bytes. */
export type UploadedFileFields = Pick<UploadedFile, 'fieldName' | 'fileName' | 'contentType'>;

/** An UploadedFile of `bytes` as the routes carry a spooled part: its size, SHA-256 and a fresh stream on each call. */
export function uploadedFile(fields: UploadedFileFields, bytes: Buffer): UploadedFile {
  return { ...fields, size: bytes.length, sha256: sha256Hex(bytes), stream: () => Readable.from([bytes]) };
}
