// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance attachments: uploads into `finance-attachments`, the attachment reads of finance.cfc, its file response and signed download URLs. */
import type { Readable } from 'node:stream';
import { LegacyApiError, cfUuid } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { FastifyReply } from '@opt2/platform/service-kit';
import { SIGNED_URL_TTL_S } from '@opt2/platform/storage';
import type { TenantTx } from '@opt2/platform/tenancy';
import { FinanceDomainError, getRecord, type FinanceActor, type FinanceDomainDeps } from './records.js';
import { findAttachment, listAttachments as queryAttachments, type Page, type RecordPaging } from '../repo/queries.js';
import { ATTACHMENT_BUCKET, attachmentObjectKey, type FinanceAttachmentRow } from '../repo/tables.js';

/** An uploaded file part, already validated at the route boundary: its byte count, lowercase hex SHA-256 and a reader of its bytes. */
export type AttachmentUpload = { recordId: string; fileName: string; contentType: string; size: number; sha256: string; body: () => Readable };

/** A time-limited download URL with its expiry as ISO-8601 UTC, the contract's `SignedUrl`. */
export type AttachmentDownloadUrl = { url: string; expiresAt: string };

/** What an attachment file response describes: the stored name and content type, and the byte length sent. */
export type FixtureFileMeta = { contentType: string; fileName: string; size: number };

/** The `nvarchar` length of each `finance_attachment` text column in the fixture. */
const TEXT_COLUMN_LIMITS = Object.freeze({ file_name: 255, content_type: 100 });

/** A `finance_attachment` text column the fixture bounds. */
export type AttachmentTextColumn = keyof typeof TEXT_COLUMN_LIMITS;

/** Raised, as the fixture's insert fails, for upload text longer than its `nvarchar` column; names the column, never the value. */
export class AttachmentColumnTooLongError extends Error {
  override readonly name = 'AttachmentColumnTooLongError';

  constructor(
    readonly column: AttachmentTextColumn,
    readonly limit: number,
  ) {
    super(`Attachment ${column} is longer than its ${limit}-character column`);
  }
}

// The only excess SQL Server drops instead of failing the insert.
const SPACES_ONLY = /^ +$/;
// POSIX [[:cntrl:]] as ACF's reFind matches it: ASCII C0 and DEL only, not U+0080-U+009F.
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
// Per code point, as Java's String.replaceAll("[^\x00-\x7F]", "_") replaces.
const NON_ASCII = /[^\u0000-\u007F]/gu;
const QUOTED_STRING_SPECIAL = /["\\]/g;
// RFC 5987 attr-char: the bytes sendFile writes as themselves in `filename*`.
const ATTR_CHAR = /^[A-Za-z0-9!#$&+.^_`|~-]$/;
// Without the u flag, so each UTF-16 unit of an astral character matches on its own.
const ABOVE_LATIN1 = /[^\u0000-\u00FF]/g;
// Control bytes Node refuses in a header value.
const UNSENDABLE_HEADER_BYTE = /[\u0000-\u0008\u000A-\u001F\u007F]/g;

/** Provenance of an attachment write by `actor`. */
function writeContext(actor: FinanceActor): WriteContext {
  return { actorUserId: actor.userId };
}

/** `value` as SQL Server stores it in `column`, by UTF-16 length: whole, or cut when only spaces exceed it; else throws `AttachmentColumnTooLongError`. */
function columnText(column: AttachmentTextColumn, value: string): string {
  const limit = TEXT_COLUMN_LIMITS[column];
  if (value.length <= limit) return value;
  if (SPACES_ONLY.test(value.slice(limit))) return value.slice(0, limit);
  throw new AttachmentColumnTooLongError(column, limit);
}

/** `filename*` value of `fileName`: its UTF-8 bytes, each outside attr-char as uppercase `%XX`. */
function extValue(fileName: string): string {
  let encoded = '';
  for (const byte of Buffer.from(fileName, 'utf8')) {
    const char = String.fromCharCode(byte);
    encoded += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/** Content-Disposition of envelope.cfc `sendFile`; throws `LegacyApiError('server_error')` when `fileName` holds a control character. */
function contentDisposition(fileName: string): string {
  if (CONTROL_CHAR.test(fileName)) throw new LegacyApiError('server_error');
  const fallback = fileName.replace(NON_ASCII, '_');
  const quoted = `attachment; filename="${fallback.replace(QUOTED_STRING_SPECIAL, '\\$&')}"`;
  return fallback === fileName ? quoted : `${quoted}; filename*=UTF-8''${extValue(fileName)}`;
}

/**
 * Content-Type value Node writes as the bytes `sendFile` sends: it puts the type on the Undertow exchange, which writes the low byte
 * of each UTF-16 unit (oracle: `€` goes out as AC), not UTF-8 as `legacyHeaderValue` sends `cfheader` values. Control bytes the
 * oracle would send raw, which Node refuses, go out as spaces.
 */
function exchangeHeaderValue(value: string): string {
  return value
    .replace(ABOVE_LATIN1, (unit) => String.fromCharCode(unit.charCodeAt(0) & 0xff))
    .replace(UNSENDABLE_HEADER_BYTE, ' ');
}

/** Headers of a file response, in the order `sendFile` sets them. */
function fileHeaders(disposition: string, size: number, contentType: string): Record<string, string> {
  return {
    'Content-Disposition': disposition,
    'Content-Length': String(size),
    'Content-Type': exchangeHeaderValue(contentType),
  };
}

/** Status-200 headers of envelope.cfc `sendFile`; throws `LegacyApiError('server_error')` when `meta.fileName` holds a control character. */
export function fixtureFileHeaders(meta: FixtureFileMeta): Record<string, string> {
  return fileHeaders(contentDisposition(meta.fileName), meta.size, meta.contentType);
}

/**
 * Stores `upload` as an attachment of its record by `actor` and returns the written row; throws `notFound` when the record is missing,
 * then `AttachmentColumnTooLongError` when its file name or content type does not fit the fixture column.
 */
export async function uploadAttachment(
  tx: TenantTx,
  deps: FinanceDomainDeps,
  upload: AttachmentUpload,
  actor: FinanceActor,
): Promise<FinanceAttachmentRow> {
  const record = await getRecord(tx, upload.recordId);
  const fileName = columnText('file_name', upload.fileName);
  const contentType = columnText('content_type', upload.contentType);
  const attachmentId = cfUuid();
  const objectKey = attachmentObjectKey(tx.tenantId, attachmentId, fileName);
  const row = await deps.repository.insertAttachment(
    tx,
    {
      tenant_id: tx.tenantId,
      attachment_id: attachmentId,
      record_id: record.record_id,
      file_name: fileName,
      content_type: contentType,
      size_bytes: upload.size,
      sha256: upload.sha256,
      object_key: objectKey,
      created: deps.clock.now(),
      createdbyid: actor.userId,
      legacy_program_id: record.legacy_program_id,
    },
    writeContext(actor),
  );
  // Streamed only after the row is written, so a write the repository rejects stores no bytes; a failed store rolls the row back with `tx`.
  await deps.storage.put(ATTACHMENT_BUCKET, objectKey, upload.body(), { contentType });
  return row;
}

/** One page of record `recordId`'s attachments by `created`, then id, with their total; throws `notFound` when the record is missing. */
export async function listAttachments(tx: TenantTx, recordId: string, paging: RecordPaging): Promise<Page<FinanceAttachmentRow>> {
  await getRecord(tx, recordId);
  return queryAttachments(tx, recordId, paging);
}

/** The attachment `attachmentId` of record `recordId`; throws `notFound` when the record or that attachment of it is missing. */
export async function getAttachment(tx: TenantTx, recordId: string, attachmentId: string): Promise<FinanceAttachmentRow> {
  await getRecord(tx, recordId);
  const attachment = await findAttachment(tx, recordId, attachmentId);
  if (attachment === null) throw new FinanceDomainError('notFound');
  return attachment;
}

/**
 * Streams the attachment's bytes with envelope.cfc `sendFile` headers and returns the reply. Throws `LegacyApiError('server_error')`,
 * before reading storage, when the file name holds a control character, and `StorageObjectNotFoundError` when the object is absent.
 */
export async function streamLegacy(reply: FastifyReply, deps: FinanceDomainDeps, attachment: FinanceAttachmentRow): Promise<FastifyReply> {
  const disposition = contentDisposition(attachment.file_name);
  // One open, not head then stream, so the length sent is that of the stored version whose bytes are streamed.
  const { head, body } = await deps.storage.open(ATTACHMENT_BUCKET, attachment.object_key);
  return reply.code(200).headers(fileHeaders(disposition, head.size, attachment.content_type)).send(body);
}

/** A download URL valid for `SIGNED_URL_TTL_S` seconds; throws `LegacyApiError('server_error')` when the file name holds a control character. */
export async function signedDownloadUrl(deps: FinanceDomainDeps, attachment: FinanceAttachmentRow): Promise<AttachmentDownloadUrl> {
  const expiresAt = new Date(deps.clock.now().getTime() + SIGNED_URL_TTL_S * 1000).toISOString();
  // The signed download names the file as the fixture download does.
  const url = await deps.storage.signedUrl(ATTACHMENT_BUCKET, attachment.object_key, {
    expiresS: SIGNED_URL_TTL_S,
    disposition: contentDisposition(attachment.file_name),
  });
  return { url, expiresAt };
}
