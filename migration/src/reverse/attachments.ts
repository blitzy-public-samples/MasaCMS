/**
 * Reverse projection of owner object bytes into their fixture `varbinary(max)` columns: finance attachment `content` in
 * `Program_<id>.finance_attachment`, and reporting export job `output` in `synthetic.export_job`.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { CanonicalValue } from '@opt2/platform/migration-kit';

import type { MigrationContext } from '../context.js';

import type { LegacyChange } from './apply-legacy.js';

/** Id of finance's attachment unit, `<schema>.<table>`. */
export const FINANCE_ATTACHMENT_UNIT = 'finance.attachment';

/** Legacy `varbinary(max)` column of the attachment bytes; the target keeps them as an object, so changes carry none. */
export const ATTACHMENT_CONTENT_COLUMN = 'content';

/** Id of reporting's export job unit, `<schema>.<table>`. */
export const EXPORT_JOB_UNIT = 'reporting.export_job';

/** Legacy `varbinary(max)` column of the export output; the target keeps it as an object, so changes carry none. */
export const EXPORT_OUTPUT_COLUMN = 'output';

// Legacy columns recording the bytes: an update changing none of them leaves the stored bytes as they are.
const BYTES_COLUMNS = new Set(['size_bytes', 'sha256']);
const OUTPUT_SHA256_COLUMN = 'output_sha256';
const OUTPUT_COLUMNS = new Set([OUTPUT_SHA256_COLUMN]);

/** The owner's object bytes differ in size or SHA-256 from the change's after-image, so none are written. */
export class AttachmentContentMismatchError extends Error {
  override readonly name = 'AttachmentContentMismatchError';

  /**
   * `expected.size` is absent when the row records no size; `exceeded` is true when reading stopped at the first chunk beyond
   * it, and `actual` then covers the bytes read. `subject` names the object in the message.
   */
  constructor(
    readonly key: string,
    readonly expected: { size?: number; sha256: string },
    readonly actual: { size: number; sha256: string },
    readonly exceeded = false,
    subject = 'Finance attachment',
  ) {
    super(
      exceeded
        ? `${subject} ${key} exceeded the change row's ${String(expected.size)} bytes: ${String(actual.size)} bytes were read`
        : `${subject} ${key} has ${String(actual.size)} bytes hashing to ${actual.sha256}, ` +
            (expected.size === undefined
              ? `not the change row's SHA-256 ${expected.sha256}`
              : `not the change row's ${String(expected.size)} bytes hashing to ${expected.sha256}`),
    );
  }
}

/** Value of column `name` in an image, matched case-insensitively as SQL Server resolves names; undefined when absent. */
function valueAt(image: Readonly<Record<string, CanonicalValue>>, name: string): CanonicalValue | undefined {
  const found = Object.keys(image).find((key) => key.toLowerCase() === name);
  return found === undefined ? undefined : image[found];
}

/** Text of column `name` in an image. */
function textAt(change: LegacyChange, image: Readonly<Record<string, CanonicalValue>>, name: string): string {
  const value = valueAt(image, name);
  if (typeof value !== 'string') throw new TypeError(`${change.op} of ${change.legacyTable} carries no text ${name}`);
  return value;
}

/** Text of column `name` in an image, or null for NULL. */
function nullableTextAt(change: LegacyChange, image: Readonly<Record<string, CanonicalValue>>, name: string): string | null {
  return valueAt(image, name) === null ? null : textAt(change, image, name);
}

/** True when the update `change` changed one of `names`, lower-case legacy column names. */
function updates(change: LegacyChange, names: ReadonlySet<string>): boolean {
  return change.op === 'update' && (change.changedColumns ?? []).some((name) => names.has(name.toLowerCase()));
}

/** The after-image of an insert or update. */
function afterOf(change: LegacyChange): Readonly<Record<string, CanonicalValue>> {
  if (change.after === undefined) throw new TypeError(`${change.op} of ${change.legacyTable} carries no after-image`);
  return change.after;
}

/** The bytes a change records: the object's key, its SHA-256, and its size where the row records one. */
interface ExpectedBytes {
  key: string;
  size?: number;
  sha256: string;
}

/** One object-backed fixture column of a unit, the bytes each change writes into it, and the owner read of those bytes. */
interface ObjectColumn {
  readonly column: string;
  /** Names the object in mismatch messages. */
  readonly subject: string;
  /** The bytes `change` writes; null when it sets the column NULL; undefined when it leaves the column as it is. */
  expected(change: LegacyChange): ExpectedBytes | null | undefined;
  open(owners: MigrationContext['owners'], tenantId: string, key: string): Promise<Readable>;
}

const OBJECT_COLUMNS: ReadonlyMap<string, ObjectColumn> = new Map([
  [
    FINANCE_ATTACHMENT_UNIT,
    {
      column: ATTACHMENT_CONTENT_COLUMN,
      subject: 'Finance attachment',
      // Every insert, and an update of the recorded size or hash.
      expected(change) {
        if (change.op !== 'insert' && !updates(change, BYTES_COLUMNS)) return undefined;
        const after = afterOf(change);
        const size = Number(textAt(change, after, 'size_bytes'));
        return { key: textAt(change, after, 'attachment_id'), size, sha256: textAt(change, after, 'sha256') };
      },
      open: (owners, tenantId, attachmentId) => owners.getAttachmentObject({ tenantId, attachmentId }),
    },
  ],
  [
    EXPORT_JOB_UNIT,
    {
      column: EXPORT_OUTPUT_COLUMN,
      subject: 'Reporting export output',
      // An insert recording a hash, and an update of the hash: the done move sets it with the file name and content type.
      expected(change) {
        if (change.op !== 'insert' && !updates(change, OUTPUT_COLUMNS)) return undefined;
        const after = afterOf(change);
        const sha256 = nullableTextAt(change, after, OUTPUT_SHA256_COLUMN);
        if (sha256 === null) return change.op === 'insert' ? undefined : null;
        return { key: textAt(change, after, 'job_id'), sha256 };
      },
      open: (owners, tenantId, jobId) => owners.getExportObject({ tenantId, jobId }),
    },
  ],
]);

/**
 * The bytes of `source`, read until its end or its first chunk beyond `expected.size`, and checked against `expected`.
 * @throws AttachmentContentMismatchError when their size or SHA-256 differs.
 */
async function readExpected(source: AsyncIterable<Uint8Array>, expected: ExpectedBytes, subject: string): Promise<Buffer> {
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of source) {
    hash.update(chunk);
    size += chunk.byteLength;
    if (expected.size !== undefined && size > expected.size) {
      exceeded = true;
      break;
    }
    chunks.push(chunk);
  }
  const sha256 = hash.digest('hex');
  if (exceeded || (expected.size !== undefined && size !== expected.size) || sha256 !== expected.sha256) {
    const { key, ...recorded } = expected;
    throw new AttachmentContentMismatchError(key, recorded, { size, sha256 }, exceeded, subject);
  }
  return Buffer.concat(chunks, size);
}

/**
 * The change with its owner's object bytes bound into the unit's fixture `varbinary(max)` column, when it writes them:
 * finance attachment `content` on an insert, or an update of `size_bytes` or `sha256`, checked against both; reporting
 * export job `output` on an insert recording `output_sha256`, or an update of it, checked against it, and NULL when the
 * update sets it NULL. Other changes return unchanged.
 * @throws AttachmentContentMismatchError when the owner's bytes differ from the after-image; OwnerCallError when the owner
 *   has none.
 */
export async function bindAttachmentContent(deps: Pick<MigrationContext, 'owners'>, change: LegacyChange): Promise<LegacyChange> {
  const objectColumn = OBJECT_COLUMNS.get(change.unit);
  const expected = objectColumn?.expected(change);
  if (objectColumn === undefined || expected === undefined) return change;
  let content: Buffer | null = null;
  if (expected !== null) {
    const source = await objectColumn.open(deps.owners, change.tenantId, expected.key);
    try {
      content = await readExpected(source, expected, objectColumn.subject);
    } finally {
      source.destroy();
    }
  }
  const { column } = objectColumn;
  const bound: LegacyChange = {
    ...change,
    columns: [...change.columns, { name: column, type: 'b' }],
    after: { ...afterOf(change), [column]: content },
  };
  if (change.changedColumns !== undefined) bound.changedColumns = [...change.changedColumns, column];
  return bound;
}
