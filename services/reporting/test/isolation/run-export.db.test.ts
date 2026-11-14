// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The export runner and the run task of a `/v1` create against PostgreSQL, with the runner's cases of deliveries overlapping one job. */
import { describe, expect, it } from 'vitest';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { pgAvailable } from '@opt2/platform/testing';
import { reclaimRun } from '../../src/domain/job-state.js';
import type { RunExportResult } from '../../src/domain/run-export.js';
import { EXPORT_BUCKET } from '../../src/repo/tables.js';
import { RERUN_AT, defineExportRunTaskCases, defineExportRunnerCases, once, sheetRow, sheetsClient } from '../helpers/run-export-cases.js';

// An unset PG_HOST skips the suite without probing the server.
const PG_READY = Boolean(process.env.PG_HOST) && (await pgAvailable());

/** A source read held open: `hold` signals `started`, then waits until `release` is called. */
function heldRead(): { started: Promise<void>; hold: () => Promise<void>; release: () => void } {
  let signal = (): void => undefined;
  let release = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    hold: () => {
      signal();
      return released;
    },
    release,
  };
}

describe.skipIf(!PG_READY)('export runner against PostgreSQL', () => {
  const runner = defineExportRunnerCases('pg');

  it('skips without a row write the finish of a delivery whose claim a later delivery took over, deleting the object it stored', async () => {
    const queued = await runner.queuedJob();
    const takeOver = once(() =>
      withGatedTenant(runner.db, queued.job.tenant_id, (tx) => reclaimRun(tx, runner.repository, { jobId: queued.job.job_id, now: RERUN_AT })),
    );
    const { client } = sheetsClient([sheetRow('T1', queued.siteId)], takeOver);

    const result = await runner.deliver(runner.runnerDeps(client), queued);

    expect(result).toStrictEqual({ outcome: 'skipped', state: 'running' });
    expect(await runner.read(queued.job)).toMatchObject({ state: 'running', started_at: RERUN_AT, finished_at: null, object_key: null, row_version: '3' });
    expect((await runner.changelogOf(queued.job)).map((row) => row.op)).toStrictEqual(['insert', 'update', 'update']);
    expect(await runner.storage.head(EXPORT_BUCKET, runner.attemptKey(queued.job, 2))).toBeNull();
  });

  it('keeps the output of the latest claim when deliveries it superseded finish after it', async () => {
    const queued = await runner.queuedJob();
    const [first, second] = [heldRead(), heldRead()];
    const deliveryOf = (timesheetId: string, hold?: () => Promise<void>): Promise<RunExportResult> =>
      runner.deliver(runner.runnerDeps(sheetsClient([sheetRow(timesheetId, queued.siteId)], hold).client), queued);

    const stale = deliveryOf('OLD', first.hold);
    await first.started;
    const staler = deliveryOf('MIDDLE', second.hold);
    await second.started;
    expect(await deliveryOf('NEW')).toStrictEqual({ outcome: 'done', state: 'done' });
    first.release();
    expect(await stale).toStrictEqual({ outcome: 'skipped', state: 'done' });
    second.release();
    expect(await staler).toStrictEqual({ outcome: 'skipped', state: 'done' });

    await runner.expectDoneAt(queued.job, runner.attemptKey(queued.job, 4), { row_version: '5' });
    expect((await runner.storage.get(EXPORT_BUCKET, runner.attemptKey(queued.job, 4))).toString()).toBe('timesheet_id,status\r\nNEW,SUBMITTED\r\n');
    for (const superseded of [2, 3]) expect(await runner.storage.head(EXPORT_BUCKET, runner.attemptKey(queued.job, superseded))).toBeNull();
  });
});

describe.skipIf(!PG_READY)('export-run task of a /v1 create through the reporting app against PostgreSQL', () => {
  defineExportRunTaskCases('pg');
});
