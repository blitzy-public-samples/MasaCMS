// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Fixture row projections against `envelope.rows()` output recorded from the legacy oracle. */
import { describe, expect, it } from 'vitest';
import type { RollupRow } from '../../src/domain/rollup.js';
import { attachmentRow, recordDetail, recordRow, rollupRow, versionRow } from '../../src/legacy/serialize.js';
import type { FinanceAttachmentRow, FinanceRecordRow, FinanceRecordVersionRow, FinanceRollupRow } from '../../src/repo/tables.js';

const RECORD_ID = '0A1B2C3D-4E5F-6A7B-8C9D0E1F2A3B4C5D';
const USER_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const VERSION_ID = '11111111-2222-3333-4444555566667777';
const ATTACHMENT_ID = '99999999-8888-7777-6666555544443333';
const TENANT_ID = '0b9a7c1e-2f3d-5a4b-8c6d-7e8f9a0b1c2d';
const TARGET_ONLY = ['tenant_id', 'legacy_program_id', 'row_version', 'legacy_row_hash', 'object_key', 'content'];

// `data` of a fixture envelope for a finance_record row (amount -0.1, created 2026-06-30 09:15:00.997, lastUpdate and lastUpdateByID NULL).
const RECORDED_RECORD = JSON.parse(
  '{"record_id":"0A1B2C3D-4E5F-6A7B-8C9D0E1F2A3B4C5D","siteid":"tenant-a","title":"123","amount":"-0.1000","period":"2026-06",' +
    '"state":"IN-PROGRESS","version":1,"created":"2026-06-30T09:15:00","createdbyid":"ABCDEF01-2345-6789-ABCDEF0123456789",' +
    '"lastupdate":"","lastupdatebyid":""}',
) as unknown;

const record: FinanceRecordRow = {
  tenant_id: TENANT_ID,
  record_id: RECORD_ID,
  siteid: 'tenant-a',
  title: '123',
  amount: '-0.1000',
  period: '2026-06',
  state: 'IN-PROGRESS',
  version: 1,
  created: new Date(2026, 5, 30, 9, 15, 0, 997),
  createdbyid: USER_ID,
  lastupdate: null,
  lastupdatebyid: null,
  legacy_program_id: 1,
  row_version: '7',
};

const version: FinanceRecordVersionRow = {
  tenant_id: TENANT_ID,
  version_id: VERSION_ID,
  record_id: RECORD_ID,
  version: 2,
  state: 'SUBMITTED',
  title: 'Q2 travel',
  amount: '1250.5000',
  period: '2026-06',
  action: 'submit',
  actor_user_id: USER_ID,
  created: new Date(2026, 0, 2, 23, 59, 59, 1),
  legacy_program_id: 1,
  row_version: '1',
};

const attachment: FinanceAttachmentRow = {
  tenant_id: TENANT_ID,
  attachment_id: ATTACHMENT_ID,
  record_id: RECORD_ID,
  file_name: '2026',
  content_type: 'application/pdf',
  size_bytes: 0,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  object_key: `${TENANT_ID}/${ATTACHMENT_ID}.bin`,
  created: new Date(2026, 5, 30, 0, 0, 0),
  createdbyid: USER_ID,
  legacy_program_id: 2,
  row_version: '1',
};

const storedRollup: FinanceRollupRow = {
  tenant_id: TENANT_ID,
  period: '2026-06',
  state: 'SUBMITTED',
  record_count: 2,
  total_amount: '0.0000',
  computed_at: new Date(2026, 5, 30, 12, 0, 5, 333),
  legacy_program_id: 1,
  row_version: '4',
};

describe('recordRow', () => {
  it('equals the recorded fixture row, keys in catalog order', () => {
    const projected = recordRow(record);
    expect(projected).toEqual(RECORDED_RECORD);
    expect(Object.keys(projected)).toEqual(Object.keys(RECORDED_RECORD as object));
  });

  it('formats a set lastupdate and passes its actor through', () => {
    expect(recordRow({ ...record, lastupdate: new Date(2026, 6, 1, 8, 5, 9, 500), lastupdatebyid: USER_ID })).toMatchObject({
      lastupdate: '2026-07-01T08:05:09',
      lastupdatebyid: USER_ID,
    });
  });

  it('throws on amount text that is not scale-4 numeric', () => {
    expect(() => recordRow({ ...record, amount: '1e3' })).toThrow(RangeError);
  });
});

describe('money', () => {
  it.each([
    ['0', '0.0000'],
    ['0.0000', '0.0000'],
    ['0.1', '0.1000'],
    ['-0.1000', '-0.1000'],
    ['-1250.5', '-1250.5000'],
    ['123456789012345.6789', '123456789012345.6789'],
    ['-999999999999999.9999', '-999999999999999.9999'],
  ])('renders numeric %s as %s in every projection', (numeric, wire) => {
    expect(recordRow({ ...record, amount: numeric }).amount).toBe(wire);
    expect(versionRow({ ...version, amount: numeric }).amount).toBe(wire);
    expect(rollupRow({ ...storedRollup, total_amount: numeric }).total_amount).toBe(wire);
  });
});

describe('versionRow', () => {
  it('projects the version fields in catalog order', () => {
    const projected = versionRow(version);
    expect(Object.keys(projected)).toEqual([
      'version_id', 'record_id', 'version', 'state', 'title', 'amount', 'period', 'action', 'actor_user_id', 'created',
    ]);
    expect(projected).toEqual({
      version_id: VERSION_ID,
      record_id: RECORD_ID,
      version: 2,
      state: 'SUBMITTED',
      title: 'Q2 travel',
      amount: '1250.5000',
      period: '2026-06',
      action: 'submit',
      actor_user_id: USER_ID,
      created: '2026-01-02T23:59:59',
    });
  });
});

describe('attachmentRow', () => {
  it('projects metadata only, never the object key or bytes', () => {
    const withBytes = { ...attachment, content: Buffer.from('%PDF') } as FinanceAttachmentRow;
    const projected = attachmentRow(withBytes);
    expect(Object.keys(projected)).toEqual([
      'attachment_id', 'record_id', 'file_name', 'content_type', 'size_bytes', 'sha256', 'created', 'createdbyid',
    ]);
    expect(projected).toMatchObject({ file_name: '2026', size_bytes: 0, created: '2026-06-30T00:00:00' });
    expect(JSON.stringify(projected)).not.toContain(TENANT_ID);
  });
});

describe('rollupRow', () => {
  const expected = { period: '2026-06', state: 'SUBMITTED', record_count: 2, total_amount: '0.0000', computed_at: '2026-06-30T12:00:05' };

  it('projects a stored row in catalog order', () => {
    const projected = rollupRow(storedRollup);
    expect(projected).toEqual(expected);
    expect(Object.keys(projected)).toEqual(Object.keys(expected));
  });

  it('projects a computed group exactly like its stored row', () => {
    const computed: RollupRow = { period: '2026-06', state: 'SUBMITTED', recordCount: 2, totalAmount: 0n, computedAt: storedRollup.computed_at };
    expect(rollupRow(computed)).toEqual(expected);
    expect(rollupRow({ ...computed, totalAmount: -1000n }).total_amount).toBe('-0.1000');
  });
});

describe('recordDetail', () => {
  it('embeds versions and attachments in the given order', () => {
    const first = { ...version, version_id: ATTACHMENT_ID, version: 1, action: 'create' };
    const detail = recordDetail(record, [version, first], [attachment]);
    expect(detail).toEqual({ ...recordRow(record), versions: [versionRow(version), versionRow(first)], attachments: [attachmentRow(attachment)] });
    expect(recordDetail(record, [], [])).toEqual({ ...recordRow(record), versions: [], attachments: [] });
  });
});

describe('target-only columns', () => {
  it.each([
    ['record', recordRow(record)],
    ['version', versionRow(version)],
    ['attachment', attachmentRow(attachment)],
    ['rollup', rollupRow(storedRollup)],
  ])('%s projection omits them', (_name, projected) => {
    for (const key of TARGET_ONLY) expect(projected).not.toHaveProperty(key);
  });
});
