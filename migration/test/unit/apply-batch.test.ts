// Unit tests for the owner batcher's buffered-row bound, batch ids and watermark placement, over a recording sender.
import type { ApplyRequest, WatermarkRecord } from '@opt2/platform/migration-kit';
import { describe, expect, it } from 'vitest';

import {
  BUFFERED_BATCHES,
  batchIdFor,
  createOwnerBatcher,
  type ApplyChange,
  type BatchSender,
  type OwnerBatcher,
  type OwnerBatcherOptions,
} from '../../src/apply/batch.js';

const PLAIN_TABLE = 'tusers';
const FOLDED_TABLE = 'Program_N.blackout';
const SNAPSHOT_SEQ = 7;

/** One `add` call of a batcher. */
interface Add {
  tenantId: string;
  change: ApplyChange;
  legacyProgramId?: number;
}

type Event = { kind: 'apply'; request: ApplyRequest } | { kind: 'watermark'; record: WatermarkRecord };

/** A sender that records every apply and watermark in call order; it rejects the apply after `failAfter` applies. */
function recordingSender(failAfter = Number.POSITIVE_INFINITY): { sender: BatchSender; events: Event[]; applied: ApplyRequest[] } {
  const events: Event[] = [];
  const applied: ApplyRequest[] = [];
  const sender: BatchSender = {
    apply(_owner, request) {
      if (applied.length >= failAfter) return Promise.reject(new Error('applier stopped'));
      applied.push(request);
      events.push({ kind: 'apply', request });
      return Promise.resolve({ batchId: request.batchId, duplicate: false, applied: request.rows.length, skipped: 0, writePositions: new Map() });
    },
    putWatermark(_owner, record) {
      events.push({ kind: 'watermark', record });
      return Promise.resolve();
    },
    get acknowledged() {
      return applied.length;
    },
  };
  return { sender, events, applied };
}

function batcherOf(sender: BatchSender, opts: Partial<OwnerBatcherOptions> & Pick<OwnerBatcherOptions, 'batchSize'>): OwnerBatcher {
  return createOwnerBatcher({
    owner: 'people',
    legacyTable: PLAIN_TABLE,
    direction: 'backfill',
    snapshotSeq: SNAPSHOT_SEQ,
    origin: 'backfill',
    columns: [{ name: 'id', type: 's' }],
    sender,
    watermark: null,
    ...opts,
  });
}

/** Round-robin rows over `tenants` tenants; with `programs`, row `i` of a tenant belongs to program `i % programs + 1`. */
function roundRobin(tenants: number, rowsPerTenant: number, programs: number): Add[] {
  const adds: Add[] = [];
  for (let index = 0; index < rowsPerTenant; index += 1) {
    for (let tenant = 0; tenant < tenants; tenant += 1) {
      const tenantId = `t${String(tenant).padStart(2, '0')}`;
      const change: ApplyChange = { op: 'upsert', row: `${tenantId}/${String(index)}` };
      adds.push(programs === 0 ? { tenantId, change } : { tenantId, change, legacyProgramId: (index % programs) + 1 });
    }
  }
  return adds;
}

/** Consecutive runs of rows per tenant, each `[tenantId, rows]`. */
function runs(...parts: [string, number][]): Add[] {
  const sent = new Map<string, number>();
  return parts.flatMap(([tenantId, count]) => {
    const start = sent.get(tenantId) ?? 0;
    sent.set(tenantId, start + count);
    return Array.from({ length: count }, (_, offset): Add => ({ tenantId, change: { op: 'upsert', row: `${tenantId}#${String(start + offset)}` } }));
  });
}

const tableOf = (legacyProgramId: number | undefined): string =>
  legacyProgramId === undefined ? PLAIN_TABLE : `Program_${String(legacyProgramId)}.blackout`;

const idOf = (legacyTable: string, tenantId: string, ordinal: number): string =>
  batchIdFor({ direction: 'backfill', snapshotSeq: SNAPSHOT_SEQ, legacyTable, tenantId, ordinal });

const layoutOf = (applied: readonly ApplyRequest[]): [string, string, number][] =>
  applied.map((request) => [request.batchId, request.tenantId ?? '', request.rows.length]);

describe('createOwnerBatcher', () => {
  it.each([
    { name: '12 tenants', tenants: 12, rowsPerTenant: 5, programs: 0, batchSize: 2 },
    { name: '9 tenants', tenants: 9, rowsPerTenant: 7, programs: 0, batchSize: 2 },
    { name: '20 tenants over two folded programs', tenants: 20, rowsPerTenant: 6, programs: 2, batchSize: 3 },
    { name: '3 tenants within the budget', tenants: 3, rowsPerTenant: 10, programs: 0, batchSize: 2 },
  ])('buffers at most the budget for $name and sends each row once in ordinal order', async ({ tenants, rowsPerTenant, programs, batchSize }) => {
    const { sender, applied } = recordingSender();
    const batcher = batcherOf(sender, { batchSize, ...(programs === 0 ? {} : { legacyTable: FOLDED_TABLE }) });
    const adds = roundRobin(tenants, rowsPerTenant, programs);
    const sentRows = (): number => applied.reduce((sum, request) => sum + request.rows.length, 0);

    let added = 0;
    let peak = 0;
    for (const add of adds) {
      await batcher.add(add.tenantId, add.change, add.legacyProgramId);
      added += 1;
      peak = Math.max(peak, added - sentRows());
    }
    // The budget plus the held batch.
    expect(peak).toBeLessThanOrEqual(batchSize * (BUFFERED_BATCHES + 1));
    const stats = await batcher.finish();

    expect(sentRows()).toBe(adds.length);
    expect(stats).toMatchObject({ batches: applied.length, changes: adds.length, watermark: 'none' });
    expect(Object.values(stats.perTenant)).toEqual(Array.from({ length: tenants }, () => rowsPerTenant));
    expect(applied.every((request) => request.rows.length >= 1 && request.rows.length <= batchSize)).toBe(true);

    const expectedRows = new Map<string, string[]>();
    for (const add of adds) {
      const key = JSON.stringify([add.tenantId, tableOf(add.legacyProgramId)]);
      expectedRows.set(key, [...(expectedRows.get(key) ?? []), add.change.row]);
    }
    const sentByPartition = new Map<string, ApplyRequest[]>();
    for (const request of applied) {
      const key = JSON.stringify([request.tenantId, request.legacyTable]);
      sentByPartition.set(key, [...(sentByPartition.get(key) ?? []), request]);
    }
    expect([...sentByPartition.keys()].sort()).toEqual([...expectedRows.keys()].sort());
    for (const [key, requests] of sentByPartition) {
      const [tenantId, legacyTable] = JSON.parse(key) as [string, string];
      expect(requests.map((request) => request.batchId)).toEqual(requests.map((_, ordinal) => idOf(legacyTable, tenantId, ordinal)));
      expect(requests.flatMap((request) => request.rows.map((row) => row.row))).toEqual(expectedRows.get(key));
    }
  });

  it.each<{ name: string; batchSize: number; adds: Add[]; expected: [tenantId: string, ordinal: number, rows: number][] }>([
    {
      name: '2,500 rows of tenant-a then 10 of tenant-b',
      batchSize: 1000,
      adds: runs(['tenant-a', 2500], ['tenant-b', 10]),
      expected: [
        ['tenant-a', 0, 1000],
        ['tenant-a', 1, 1000],
        ['tenant-a', 2, 500],
        ['tenant-b', 0, 10],
      ],
    },
    {
      name: 'a refed partition past the budget',
      batchSize: 3,
      adds: [...roundRobin(12, 1, 0), ...runs(['t00', 1])],
      expected: [
        ['t01', 0, 1],
        ['t00', 0, 2],
        ...Array.from({ length: 10 }, (_, index): [string, number, number] => [`t${String(index + 2).padStart(2, '0')}`, 0, 1]),
      ],
    },
  ])('sends $name as the expected batches', async ({ batchSize, adds, expected }) => {
    const { sender, applied } = recordingSender();
    const batcher = batcherOf(sender, { batchSize });
    for (const add of adds) await batcher.add(add.tenantId, add.change);
    await batcher.finish();

    expect(layoutOf(applied)).toEqual(expected.map(([tenantId, ordinal, rows]) => [idOf(PLAIN_TABLE, tenantId, ordinal), tenantId, rows]));
  });

  it('resends the batches an interrupted run sent with the same ids and rows when the same input is replayed', async () => {
    const adds = roundRobin(11, 4, 0);
    const interrupted = recordingSender(3);
    const first = batcherOf(interrupted.sender, { batchSize: 2 });
    await expect(
      (async () => {
        for (const add of adds) await first.add(add.tenantId, add.change);
      })(),
    ).rejects.toThrow('applier stopped');

    const replay = recordingSender();
    const second = batcherOf(replay.sender, { batchSize: 2 });
    for (const add of adds) await second.add(add.tenantId, add.change);
    await second.finish();

    expect(interrupted.applied).toHaveLength(3);
    expect(replay.applied.slice(0, 3)).toEqual(interrupted.applied);
  });

  it.each([
    { name: 'its own table', legacyTable: PLAIN_TABLE, programs: 0, stored: 'batch' as const },
    { name: 'a folded Program_N table', legacyTable: FOLDED_TABLE, programs: 2, stored: 'putWatermark' as const },
  ])('places the watermark of $name after partial batches as $stored', async ({ legacyTable, programs, stored }) => {
    const watermark: WatermarkRecord = { legacyTable, direction: 'forward', snapshotSeq: SNAPSHOT_SEQ, backupLsn: '42', finishedAt: '2026-06-30T12:00:00.000Z' };
    const { sender, events, applied } = recordingSender();
    const batcher = batcherOf(sender, { batchSize: 2, legacyTable, watermark });
    for (const add of roundRobin(10, 3, programs)) await batcher.add(add.tenantId, add.change, add.legacyProgramId);
    const stats = await batcher.finish();

    expect(applied.some((request) => request.rows.length < 2)).toBe(true);
    expect(stats.watermark).toBe(stored);
    const carried = { direction: 'forward', finishedAt: watermark.finishedAt, snapshotSeq: SNAPSHOT_SEQ, backupLsn: '42' };
    expect(applied.flatMap((request) => (request.watermark === undefined ? [] : [request.watermark]))).toEqual(stored === 'batch' ? [carried] : []);
    expect(events.at(-1)).toMatchObject(
      stored === 'batch' ? { kind: 'apply', request: { legacyTable, watermark: carried } } : { kind: 'watermark', record: watermark },
    );
    expect(events.filter((event) => event.kind === 'watermark')).toHaveLength(stored === 'batch' ? 0 : 1);
  });
});
