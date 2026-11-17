// Unit tests for binding owner object bytes into projected finance_attachment and export_job changes through fake owners.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { tenantIdForSite } from '@opt2/platform/tenancy';
import { describe, expect, it, vi } from 'vitest';

import { OwnerCallError, type OwnersClient } from '../../src/owners/client.js';
import type { LegacyChange } from '../../src/reverse/apply-legacy.js';
import {
  ATTACHMENT_CONTENT_COLUMN,
  AttachmentContentMismatchError,
  EXPORT_JOB_UNIT,
  EXPORT_OUTPUT_COLUMN,
  FINANCE_ATTACHMENT_UNIT,
  bindAttachmentContent,
} from '../../src/reverse/attachments.js';

const TENANT = tenantIdForSite('tenant-a');
const ATTACHMENT_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const RECORD_ID = 'C1D2E3F4-0002-4A5B-8C7D9E0F1A2B3C4D';
const BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0d, 0x0a]);
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const COLUMNS: LegacyChange['columns'] = [
  { name: 'attachment_id', type: 's' },
  { name: 'record_id', type: 's' },
  { name: 'file_name', type: 's' },
  { name: 'content_type', type: 's' },
  { name: 'size_bytes', type: 'i' },
  { name: 'sha256', type: 's' },
  { name: 'created', type: 't' },
  { name: 'createdByID', type: 's' },
];

/** A legacy after-image of the attachment recording `bytes`. */
function image(bytes: Buffer, fileName = 'scan.pdf'): Record<string, string> {
  return {
    attachment_id: ATTACHMENT_ID,
    record_id: RECORD_ID,
    file_name: fileName,
    content_type: 'application/pdf',
    size_bytes: String(bytes.byteLength),
    sha256: sha(bytes),
    created: '2026-06-30 12:00:00.000',
    createdByID: RECORD_ID,
  };
}

/** A decoded `Program_1.finance_attachment` change of `unit`. */
function change(op: LegacyChange['op'], images: Pick<LegacyChange, 'before' | 'after' | 'changedColumns'>, unit = FINANCE_ATTACHMENT_UNIT): LegacyChange {
  return {
    owner: 'finance',
    tenantId: TENANT,
    unit,
    xid: '700',
    seq: '1',
    op,
    legacyTable: 'Program_1.finance_attachment',
    physicalTable: { schema: 'Program_1', table: 'finance_attachment', qualified: 'Program_1.finance_attachment' },
    columns: COLUMNS,
    key: `["${ATTACHMENT_ID}"]`,
    programId: 1,
    ...images,
  };
}

/** A finance owner serving `stream` for every attachment read. */
function owners(stream: () => Readable) {
  const getAttachmentObject = vi.fn((_params: { tenantId: string; attachmentId: string }) => Promise.resolve(stream()));
  return { deps: { owners: { getAttachmentObject } as unknown as OwnersClient }, getAttachmentObject };
}

describe('bindAttachmentContent', () => {
  it('binds the verified bytes of an insert as content, read in chunks from finance by tenant and attachment id', async () => {
    let source: Readable | undefined;
    const h = owners(() => (source = Readable.from([BYTES.subarray(0, 3), BYTES.subarray(3)])));
    const insert = change('insert', { after: image(BYTES) });

    const bound = await bindAttachmentContent(h.deps, insert);

    expect(h.getAttachmentObject).toHaveBeenCalledWith({ tenantId: TENANT, attachmentId: ATTACHMENT_ID });
    expect(Buffer.isBuffer(bound.after?.[ATTACHMENT_CONTENT_COLUMN])).toBe(true);
    expect((bound.after?.[ATTACHMENT_CONTENT_COLUMN] as Buffer).equals(BYTES)).toBe(true);
    expect(bound.after).toMatchObject(image(BYTES));
    expect(bound.columns).toEqual([...COLUMNS, { name: 'content', type: 'b' }]);
    expect(bound.changedColumns).toBeUndefined();
    expect(insert.after).not.toHaveProperty(ATTACHMENT_CONTENT_COLUMN);
    expect(source?.destroyed).toBe(true);
  });

  it('binds an empty attachment as zero bytes', async () => {
    const empty = Buffer.alloc(0);
    const bound = await bindAttachmentContent(owners(() => Readable.from([])).deps, change('insert', { after: image(empty) }));
    expect(bound.after?.[ATTACHMENT_CONTENT_COLUMN]).toEqual(empty);
  });

  it.each([['sha256'], ['SIZE_BYTES']])('binds the new bytes of an update changing %s and marks content changed', async (changed) => {
    const replaced = Buffer.from('replacement bytes');
    const update = change('update', { before: image(BYTES), after: image(replaced), changedColumns: [changed] });

    const bound = await bindAttachmentContent(owners(() => Readable.from([replaced])).deps, update);

    expect((bound.after?.[ATTACHMENT_CONTENT_COLUMN] as Buffer).equals(replaced)).toBe(true);
    expect(bound.changedColumns).toEqual([changed, 'content']);
    expect(bound.before).toEqual(image(BYTES));
  });

  it.each<[string, LegacyChange]>([
    ['an update changing neither size nor hash', change('update', { before: image(BYTES), after: image(BYTES, 'renamed.pdf'), changedColumns: ['file_name'] })],
    ['a delete', change('delete', { before: image(BYTES) })],
    ['an insert of another unit', change('insert', { after: image(BYTES) }, 'finance.record')],
  ])('passes %s through without reading finance', async (_label, unchanged) => {
    const h = owners(() => Readable.from([BYTES]));
    expect(await bindAttachmentContent(h.deps, unchanged)).toBe(unchanged);
    expect(h.getAttachmentObject).not.toHaveBeenCalled();
  });

  it.each<[string, Buffer, object]>([
    ['fewer bytes', BYTES.subarray(0, 5), { exceeded: false, actual: { size: 5, sha256: sha(BYTES.subarray(0, 5)) } }],
    ['other bytes of the same size', Buffer.alloc(BYTES.byteLength, 0x61), { exceeded: false, actual: { size: BYTES.byteLength, sha256: sha(Buffer.alloc(BYTES.byteLength, 0x61)) } }],
  ])('throws AttachmentContentMismatchError for %s and destroys the stream', async (_label, served, details) => {
    let source: Readable | undefined;
    const error = await bindAttachmentContent(
      owners(() => (source = Readable.from([served]))).deps,
      change('insert', { after: image(BYTES) }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AttachmentContentMismatchError);
    expect(error).toMatchObject({ name: 'AttachmentContentMismatchError', key: ATTACHMENT_ID, expected: { size: BYTES.byteLength, sha256: sha(BYTES) }, ...details });
    expect((error as Error).message).toMatch(new RegExp(`^Finance attachment ${ATTACHMENT_ID} has \\d+ bytes hashing to [0-9a-f]{64}, not the change row's 8 bytes`));
    expect(source?.destroyed).toBe(true);
  });

  it('stops reading an endless object at the first chunk beyond its size and destroys the stream', async () => {
    const endless = Readable.from(
      (function* (): Generator<Buffer> {
        for (;;) yield Buffer.alloc(3, 0x61);
      })(),
    );

    const error = await bindAttachmentContent(owners(() => endless).deps, change('insert', { after: image(BYTES) })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AttachmentContentMismatchError);
    expect(error).toMatchObject({ exceeded: true, actual: { size: 9 } });
    expect((error as Error).message).toBe(`Finance attachment ${ATTACHMENT_ID} exceeded the change row's 8 bytes: 9 bytes were read`);
    expect(endless.destroyed).toBe(true);
  });

  it('propagates finance answering 404 for the attachment', async () => {
    const absent = new OwnerCallError('finance', 'GET', '/internal/v1/migration/objects', 404, { error: { message: 'Invalid method call' } });
    const deps = { owners: { getAttachmentObject: () => Promise.reject(absent) } as unknown as OwnersClient };
    await expect(bindAttachmentContent(deps, change('insert', { after: image(BYTES) }))).rejects.toBe(absent);
  });

  it('refuses an insert whose after-image lacks the recorded size', async () => {
    const { size_bytes: _omitted, ...after } = image(BYTES);
    const h = owners(() => Readable.from([BYTES]));
    await expect(bindAttachmentContent(h.deps, change('insert', { after }))).rejects.toThrow(TypeError);
    expect(h.getAttachmentObject).not.toHaveBeenCalled();
  });
});

describe('bindAttachmentContent of reporting export jobs', () => {
  const JOB_ID = 'D1E2F3A4-0001-4B5C-8D7E9F0A1B2C3D4E';
  const OUTPUT = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x0d, 0x0a, 0x80]);
  const JOB_COLUMNS: LegacyChange['columns'] = [
    { name: 'job_id', type: 's' },
    { name: 'siteID', type: 's' },
    { name: 'state', type: 's' },
    { name: 'finished_at', type: 't' },
    { name: 'file_name', type: 's' },
    { name: 'content_type', type: 's' },
    { name: 'output_sha256', type: 's' },
  ];

  /** A legacy image of the job in `state`, recording `output` once done. */
  const jobImage = (state: string, output: Buffer | null): Record<string, string | null> => ({
    job_id: JOB_ID,
    siteID: 'tenant-a',
    state,
    finished_at: output === null ? null : '2026-06-30 12:00:00.000',
    file_name: output === null ? null : `export-${JOB_ID}.xlsx`,
    content_type: output === null ? null : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    output_sha256: output === null ? null : sha(output),
  });

  /** A decoded `synthetic.export_job` change. */
  const jobChange = (op: LegacyChange['op'], images: Pick<LegacyChange, 'before' | 'after' | 'changedColumns'>): LegacyChange => ({
    owner: 'reporting',
    tenantId: TENANT,
    unit: EXPORT_JOB_UNIT,
    xid: '800',
    seq: '1',
    op,
    legacyTable: 'synthetic.export_job',
    physicalTable: { schema: 'synthetic', table: 'export_job', qualified: 'synthetic.export_job' },
    columns: JOB_COLUMNS,
    key: `["${JOB_ID}"]`,
    ...images,
  });

  const DONE_COLUMNS = ['state', 'finished_at', 'file_name', 'content_type', 'output_sha256'];

  /** A reporting owner serving `stream` for every export output read. */
  function reporting(stream: () => Readable) {
    const getExportObject = vi.fn((_params: { tenantId: string; jobId: string }) => Promise.resolve(stream()));
    return { deps: { owners: { getExportObject } as unknown as OwnersClient }, getExportObject };
  }

  it.each<[string, () => LegacyChange, string[] | undefined]>([
    ['an insert recording output_sha256', () => jobChange('insert', { after: jobImage('done', OUTPUT) }), undefined],
    [
      'the done update',
      () => jobChange('update', { before: jobImage('running', null), after: jobImage('done', OUTPUT), changedColumns: DONE_COLUMNS }),
      [...DONE_COLUMNS, 'output'],
    ],
  ])('binds the verified output of %s, read whole in chunks from reporting by tenant and job id', async (_label, make, changedColumns) => {
    let source: Readable | undefined;
    const h = reporting(() => (source = Readable.from([OUTPUT.subarray(0, 4), OUTPUT.subarray(4)])));
    const projected = make();

    const bound = await bindAttachmentContent(h.deps, projected);

    expect(h.getExportObject).toHaveBeenCalledWith({ tenantId: TENANT, jobId: JOB_ID });
    expect((bound.after?.[EXPORT_OUTPUT_COLUMN] as Buffer).equals(OUTPUT)).toBe(true);
    expect(bound.after).toMatchObject(jobImage('done', OUTPUT));
    expect(bound.columns).toEqual([...JOB_COLUMNS, { name: 'output', type: 'b' }]);
    expect(bound.changedColumns).toEqual(changedColumns);
    expect(projected.after).not.toHaveProperty(EXPORT_OUTPUT_COLUMN);
    expect(source?.destroyed).toBe(true);
  });

  it('binds NULL output, reading nothing, for an update setting output_sha256 NULL', async () => {
    const h = reporting(() => Readable.from([OUTPUT]));
    const update = jobChange('update', { before: jobImage('done', OUTPUT), after: jobImage('failed', null), changedColumns: DONE_COLUMNS });

    const bound = await bindAttachmentContent(h.deps, update);

    expect(bound.after?.[EXPORT_OUTPUT_COLUMN]).toBeNull();
    expect(bound.changedColumns).toEqual([...DONE_COLUMNS, 'output']);
    expect(h.getExportObject).not.toHaveBeenCalled();
  });

  it.each<[string, LegacyChange]>([
    ['an insert of a queued job without output_sha256', jobChange('insert', { after: jobImage('queued', null) })],
    [
      'an update leaving output_sha256 unchanged',
      jobChange('update', { before: jobImage('queued', null), after: jobImage('running', null), changedColumns: ['state', 'started_at'] }),
    ],
    ['a delete', jobChange('delete', { before: jobImage('done', OUTPUT) })],
  ])('passes %s through without reading reporting', async (_label, unchanged) => {
    const h = reporting(() => Readable.from([OUTPUT]));
    expect(await bindAttachmentContent(h.deps, unchanged)).toBe(unchanged);
    expect(h.getExportObject).not.toHaveBeenCalled();
  });

  it('throws AttachmentContentMismatchError for output whose SHA-256 differs from output_sha256 and destroys the stream', async () => {
    let source: Readable | undefined;
    const served = Buffer.concat([OUTPUT, Buffer.from('tail')]);
    const error = await bindAttachmentContent(
      reporting(() => (source = Readable.from([served]))).deps,
      jobChange('update', { before: jobImage('running', null), after: jobImage('done', OUTPUT), changedColumns: DONE_COLUMNS }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AttachmentContentMismatchError);
    expect(error).toMatchObject({ key: JOB_ID, expected: { sha256: sha(OUTPUT) }, actual: { size: served.byteLength, sha256: sha(served) }, exceeded: false });
    expect((error as AttachmentContentMismatchError).expected).not.toHaveProperty('size');
    expect((error as Error).message).toBe(
      `Reporting export output ${JOB_ID} has ${String(served.byteLength)} bytes hashing to ${sha(served)}, not the change row's SHA-256 ${sha(OUTPUT)}`,
    );
    expect(source?.destroyed).toBe(true);
  });

  it('propagates reporting answering 404 for the job output', async () => {
    const absent = new OwnerCallError('reporting', 'GET', '/internal/v1/migration/objects', 404, { error: { message: 'Invalid method call' } });
    const deps = { owners: { getExportObject: () => Promise.reject(absent) } as unknown as OwnersClient };
    await expect(bindAttachmentContent(deps, jobChange('insert', { after: jobImage('done', OUTPUT) }))).rejects.toBe(absent);
  });
});

