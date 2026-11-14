// Unit tests for runFault's verdict: outcome, exit code and written report result from a double script's assertions.
import { z } from '@opt2/platform/service-kit';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { runFault, type FaultReportBlock, type RunFaultDeps, type RunFaultResult } from '../../src/faults/index.js';
import type { ProcessControl } from '../../src/faults/process-control.js';
import { fail, pass, skipped, type FaultAssertion, type FaultScript } from '../../src/faults/scripts/types.js';
import { loadUnitCatalog } from '../../src/owners/index.js';
import type { ReconcileReport, ReconcileResult } from '../../src/reconcile/index.js';
import type { SnapshotRecord } from '../../src/snapshot/index.js';
import { createGatewayDouble } from '../helpers/gateway-double.js';

const CONFIG = loadConfig();
const CATALOG = loadUnitCatalog(CONFIG.paths.tableOwnership);
const RECONCILING_FAULT = 'window-import-interrupted';
const TOGGLE_FAULT = 'projector-delay';
const POINT = `after-fault-${RECONCILING_FAULT}`;
const REPORT_PATH = `/reports/reconciliation/${POINT}.json`;
const LIVE_DATABASE = 'masa_test';

/** One verdict case: the double script's assertions, the reconciliation's own result and the expected verdict. */
interface VerdictCase {
  label: string;
  reconciles: boolean;
  run: FaultAssertion[];
  resume: FaultAssertion[];
  reconciled: ReconcileResult;
  outcome: RunFaultResult['outcome'];
  exitCode: 0 | 1;
  /** The written report's `result`; absent for a toggle, which writes none. */
  result?: ReconcileResult;
}

const PASSED = pass('injected');
const SKIPPED = skipped('read-checked', 'the read cannot reach the target under v0001');
const FAILED = fail('recovered', { state: 'import-pending' }, 'the window did not close');

const CASES: VerdictCase[] = [
  { label: 'every assertion passed', reconciles: true, run: [PASSED], resume: [PASSED], reconciled: 'zero-difference', outcome: 'passed', exitCode: 0, result: 'zero-difference' },
  { label: 'every assertion passed over a difference', reconciles: true, run: [PASSED], resume: [], reconciled: 'difference', outcome: 'passed', exitCode: 1, result: 'difference' },
  { label: 'a skipped run assertion and no failure', reconciles: true, run: [PASSED, SKIPPED], resume: [PASSED], reconciled: 'zero-difference', outcome: 'unmet', exitCode: 1, result: 'zero-difference' },
  { label: 'a skipped resume assertion and no failure', reconciles: true, run: [PASSED], resume: [SKIPPED], reconciled: 'zero-difference', outcome: 'unmet', exitCode: 1, result: 'zero-difference' },
  { label: 'a failed and a skipped assertion', reconciles: true, run: [SKIPPED], resume: [FAILED], reconciled: 'zero-difference', outcome: 'failed', exitCode: 1, result: 'difference' },
  { label: 'a toggle whose assertion passed', reconciles: false, run: [PASSED], resume: [], reconciled: 'zero-difference', outcome: 'toggled', exitCode: 0 },
  { label: 'a toggle with a skipped assertion', reconciles: false, run: [PASSED, SKIPPED], resume: [], reconciled: 'zero-difference', outcome: 'unmet', exitCode: 1 },
  { label: 'a toggle with a failed and a skipped assertion', reconciles: false, run: [SKIPPED, FAILED], resume: [], reconciled: 'zero-difference', outcome: 'failed', exitCode: 1 },
];

function doubleScript(entry: VerdictCase): FaultScript {
  return {
    name: entry.reconciles ? RECONCILING_FAULT : TOGGLE_FAULT,
    reconciles: entry.reconciles,
    paramsSchema: z.object({}).strict(),
    run: () => Promise.resolve({ assertions: entry.run }),
    resume: () => Promise.resolve({ steps: ['resumed'], assertions: entry.resume }),
  };
}

function reconcileReport(result: ReconcileResult): ReconcileReport {
  return { point: POINT, expectedTableVersion: 'v0001', tableVersion: 'v0001', legacySource: 'live', legacyDatabase: LIVE_DATABASE, units: [], result } as unknown as ReconcileReport;
}

/** A context over the committed config and catalog, a gateway double at v0001 and a fixed clock. */
function context(): MigrationContext {
  return {
    env: { MURA_DATABASE: LIVE_DATABASE },
    config: CONFIG,
    catalog: CATALOG,
    gateway: createGatewayDouble({ active: 'v0001' }),
    clock: { now: () => new Date('2026-06-30T10:00:00.000Z') },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as MigrationContext;
}

describe('runFault verdict', () => {
  it.each(CASES)('reports $outcome, exit $exitCode for $label', async (entry) => {
    const written: (ReconcileReport & { fault: FaultReportBlock })[] = [];
    const reconcile = vi.fn<NonNullable<RunFaultDeps['reconcile']>>(() => Promise.resolve(reconcileReport(entry.reconciled)));
    const deps: RunFaultDeps = {
      scripts: { [entry.reconciles ? RECONCILING_FAULT : TOGGLE_FAULT]: doubleScript(entry) },
      processControl: {} as ProcessControl,
      remote: { set: vi.fn(() => Promise.resolve()), clear: vi.fn(() => Promise.resolve()) },
      reconcile,
      writeReport: (_ctx, report) => {
        written.push(report as ReconcileReport & { fault: FaultReportBlock });
        return Promise.resolve(REPORT_PATH);
      },
      latestSnapshot: () => Promise.resolve({ seq: 4, databaseName: 'masa_snapshot_4' } as SnapshotRecord),
      sleep: () => Promise.resolve(),
    };

    const result = await runFault(context(), entry.reconciles ? RECONCILING_FAULT : TOGGLE_FAULT, {}, deps);

    expect(result).toMatchObject({ outcome: entry.outcome, exitCode: entry.exitCode, assertions: [...entry.run, ...entry.resume] });
    expect(result.error).toBeUndefined();
    if (entry.result === undefined) {
      expect(result.reconciliation).toBeUndefined();
      expect(reconcile).not.toHaveBeenCalled();
      expect(written).toStrictEqual([]);
      return;
    }
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ point: POINT, database: LIVE_DATABASE, snapshotSeq: 4, legacySource: 'live' }));
    expect(result.reconciliation).toStrictEqual({ point: POINT, result: entry.result, reportPath: REPORT_PATH });
    expect(written).toHaveLength(1);
    expect(written[0]?.result).toBe(entry.result);
    expect(written[0]?.fault).toMatchObject({ name: RECONCILING_FAULT, outcome: entry.outcome, tableVersion: 'v0001', steps: ['resumed'], assertions: [...entry.run, ...entry.resume] });
  });
});
