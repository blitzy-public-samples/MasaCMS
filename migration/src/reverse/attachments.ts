/** Reverse projection of finance attachment bytes into the fixture `Program_<id>.finance_attachment.content` column. */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { CanonicalValue } from '@opt2/platform/migration-kit';

import type { MigrationContext } from '../context.js';

import type { LegacyChange } from './apply-legacy.js';

/** Id of finance's attachment unit, `<schema>.<table>`. */
export const FINANCE_ATTACHMENT_UNIT = 'finance.attachment';

/** Legacy `varbinary(max)` column of the attachment bytes; the target keeps them as an object, so changes carry none. */
export const ATTACHMENT_CONTENT_COLUMN = 'content';

// Legacy columns recording the bytes: an update changing neither leaves the stored bytes as they are.
const BYTES_COLUMNS = new Set(['size_bytes', 'sha256']);

/** The owner's attachment bytes differ in size or SHA-256 from the change's after-image, so none are written. */
export class AttachmentContentMismatchError extends Error {
  override readonly name = 'AttachmentContentMismatchError';

  /** `exceeded` is true when reading stopped at the first chunk beyond the row's size; `actual` then covers the bytes read. */
  constructor(
    readonly key: string,
    readonly expected: { size: number; sha256: string },
    readonly actual: { size: number; sha256: string },
    readonly exceeded = false,
  ) {
    super(
      exceeded
        ? `Finance attachment ${key} exceeded the change row's ${String(expected.size)} bytes: ${String(actual.size)} bytes were read`
        : `Finance attachment ${key} has ${String(actual.size)} bytes hashing to ${actual.sha256}, ` +
            `not the change row's ${String(expected.size)} bytes hashing to ${expected.sha256}`,
    );
  }
}

/** Text of column `name` in an image, matched case-insensitively as SQL Server resolves names. */
function textAt(change: LegacyChange, image: Readonly<Record<string, CanonicalValue>>, name: string): string {
  const found = Object.keys(image).find((key) => key.toLowerCase() === name);
  const value = found === undefined ? undefined : image[found];
  if (typeof value !== 'string') throw new TypeError(`${change.op} of ${change.legacyTable} carries no text ${name}`);
  return value;
}

/** True when the change writes bytes legacy must hold: every insert, and an update of the recorded size or hash. */
function writesBytes(change: LegacyChange): boolean {
  if (change.op === 'insert') return true;
  return change.op === 'update' && (change.changedColumns ?? []).some((name) => BYTES_COLUMNS.has(name.toLowerCase()));
}

/**
 * The bytes of `source`, read until its end or its first chunk beyond `expected.size`, and checked against `expected`.
 * @throws AttachmentContentMismatchError when their size or SHA-256 differs.
 */
async function readExpected(source: AsyncIterable<Uint8Array>, key: string, expected: { size: number; sha256: string }): Promise<Buffer> {
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of source) {
    hash.update(chunk);
    size += chunk.byteLength;
    if (size > expected.size) {
      exceeded = true;
      break;
    }
    chunks.push(chunk);
  }
  const sha256 = hash.digest('hex');
  if (exceeded || size !== expected.size || sha256 !== expected.sha256) {
    throw new AttachmentContentMismatchError(key, expected, { size, sha256 }, exceeded);
  }
  return Buffer.concat(chunks, size);
}

/**
 * The change with the attachment's bytes bound as `content` when it is a `finance.attachment` insert, or an update of
 * its size or hash: the bytes are read from finance and checked against the after-image's `size_bytes` and `sha256`.
 * Other changes return unchanged.
 * @throws AttachmentContentMismatchError when finance's bytes differ from the after-image; OwnerCallError when finance
 *   has none.
 */
export async function bindAttachmentContent(deps: Pick<MigrationContext, 'owners'>, change: LegacyChange): Promise<LegacyChange> {
  if (change.unit !== FINANCE_ATTACHMENT_UNIT || !writesBytes(change)) return change;
  const after = change.after;
  if (after === undefined) throw new TypeError(`${change.op} of ${change.legacyTable} carries no after-image`);
  const attachmentId = textAt(change, after, 'attachment_id');
  const expected = { size: Number(textAt(change, after, 'size_bytes')), sha256: textAt(change, after, 'sha256') };
  const source = await deps.owners.getAttachmentObject({ tenantId: change.tenantId, attachmentId });
  let content: Buffer;
  try {
    content = await readExpected(source, attachmentId, expected);
  } finally {
    source.destroy();
  }
  const bound: LegacyChange = {
    ...change,
    columns: [...change.columns, { name: ATTACHMENT_CONTENT_COLUMN, type: 'b' }],
    after: { ...after, [ATTACHMENT_CONTENT_COLUMN]: content },
  };
  if (change.changedColumns !== undefined) bound.changedColumns = [...change.changedColumns, ATTACHMENT_CONTENT_COLUMN];
  return bound;
}
