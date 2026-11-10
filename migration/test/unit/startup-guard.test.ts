// Unit tests for the start-up guard, using fake SQL scopes and recorded steps in place of SQL Server and the gateway.
import { readFileSync } from 'node:fs';

import type { Request } from 'mssql';
import { describe, expect, it, vi } from 'vitest';

import {
  commitWithStartupGuard,
  countStartupRows,
  runStartupGuardSequence,
  STARTUP_COUNT_SQL,
  STARTUP_PREDICATE_WHERE,
  type StartupGuardSteps,
} from '../../src/legacy/startup-guard.js';

const MASA_APP_START = new URL('../../../core/appcfc/onApplicationStart_include.cfm', import.meta.url);
const FULL_SEQUENCE = ['freezeLegacyBound', 'commit', 'runReloadWindow', 'unfreeze'];

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Scope whose request().query resolves with `recordset`, or rejects with `error`. */
function fakeScope(recordset: unknown[], error?: Error) {
  const query = vi.fn(async (_sql: string) => {
    if (error !== undefined) throw error;
    return { recordset, recordsets: [recordset], rowsAffected: [recordset.length], output: {} };
  });
  const request = vi.fn(() => ({ query }) as unknown as Request);
  return { scope: { request }, query, request };
}

/** Steps that record their call order; a step named in `failures` rejects with that error. */
function recordedSteps(failures: Partial<Record<keyof StartupGuardSteps, Error>> = {}) {
  const calls: string[] = [];
  const step =
    <T>(name: keyof StartupGuardSteps, value: T) =>
    async (): Promise<T> => {
      calls.push(name);
      const failure = failures[name];
      if (failure !== undefined) throw failure;
      return value;
    };
  const steps: StartupGuardSteps<string, number> = {
    freezeLegacyBound: step('freezeLegacyBound', undefined),
    commit: step('commit', 'committed'),
    runReloadWindow: step('runReloadWindow', 7),
    unfreeze: step('unfreeze', undefined),
  };
  return { calls, steps };
}

describe('start-up predicate', () => {
  it("equals Masa's legacy URL conversion condition at onApplicationStart_include.cfm:896-899", () => {
    const select = readFileSync(MASA_APP_START, 'utf8').split(/\r?\n/).slice(895, 899).join('\n');
    const marker = 'from tcontent where ';
    const masaWhere = select.slice(select.indexOf(marker) + marker.length, select.lastIndexOf('"'));

    expect(normalise(STARTUP_PREDICATE_WHERE)).toBe(normalise(masaWhere));
    expect(normalise(STARTUP_PREDICATE_WHERE)).toBe(
      "type in ('File','Link') and active=1 and body is null and filename is not null",
    );
  });

  it('counts unqualified tcontent rows with that predicate', () => {
    expect(STARTUP_COUNT_SQL).toBe(`select count(*) as n from tcontent where ${STARTUP_PREDICATE_WHERE}`);
  });
});

describe('countStartupRows', () => {
  it.each([
    [0, 0],
    [3, 3],
    ['12', 12],
  ])('sends the count SQL through request().query and returns n=%j as the number %d', async (n, expected) => {
    const { scope, query, request } = fakeScope([{ n }]);

    await expect(countStartupRows(scope)).resolves.toBe(expected);
    expect(request).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledExactlyOnceWith(STARTUP_COUNT_SQL);
  });

  it('rejects when the count returns no row', async () => {
    await expect(countStartupRows(fakeScope([]).scope)).rejects.toThrow('Start-up predicate count returned no row');
  });

  it('propagates a query failure unchanged', async () => {
    const failure = new Error('connection lost');

    await expect(countStartupRows(fakeScope([], failure).scope)).rejects.toBe(failure);
  });
});

describe('runStartupGuardSequence', () => {
  it('freezes, commits, runs the reload window and unfreezes, in that order', async () => {
    const { calls, steps } = recordedSteps();

    await expect(runStartupGuardSequence(steps)).resolves.toEqual({ commit: 'committed', reload: 7 });
    expect(calls).toEqual(FULL_SEQUENCE);
  });

  it.each([
    ['freezeLegacyBound', ['freezeLegacyBound', 'unfreeze']],
    ['commit', ['freezeLegacyBound', 'commit', 'unfreeze']],
    ['runReloadWindow', FULL_SEQUENCE],
  ] as const)('unfreezes and rethrows the original error when %s fails', async (failing, expectedCalls) => {
    const failure = new Error(`${failing} failed`);
    const { calls, steps } = recordedSteps({ [failing]: failure });

    await expect(runStartupGuardSequence(steps)).rejects.toBe(failure);
    expect(calls).toEqual(expectedCalls);
  });

  it('reports both errors, step error first, when a step and unfreeze fail', async () => {
    const stepFailure = new Error('commit failed');
    const unfreezeFailure = new Error('unfreeze failed');
    const { steps } = recordedSteps({ commit: stepFailure, unfreeze: unfreezeFailure });

    const error = await runStartupGuardSequence(steps).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([stepFailure, unfreezeFailure]);
  });

  it('propagates an unfreeze failure after every step succeeded', async () => {
    const unfreezeFailure = new Error('unfreeze failed');
    const { calls, steps } = recordedSteps({ unfreeze: unfreezeFailure });

    await expect(runStartupGuardSequence(steps)).rejects.toBe(unfreezeFailure);
    expect(calls).toEqual(FULL_SEQUENCE);
  });
});

describe('commitWithStartupGuard', () => {
  it.each([
    [0, { guarded: false, count: 0 }, ['commit']],
    [1, { guarded: true, count: 1 }, FULL_SEQUENCE],
    [2, { guarded: true, count: 2 }, FULL_SEQUENCE],
  ])('with %d matching rows returns %j after calling %j', async (n, outcome, expectedCalls) => {
    const { calls, steps } = recordedSteps();

    await expect(commitWithStartupGuard({ scope: fakeScope([{ n }]).scope, ...steps })).resolves.toEqual({
      ...outcome,
      commit: 'committed',
    });
    expect(calls).toEqual(expectedCalls);
  });

  it('runs no step when the count fails', async () => {
    const failure = new Error('connection lost');
    const { calls, steps } = recordedSteps();

    await expect(commitWithStartupGuard({ scope: fakeScope([], failure).scope, ...steps })).rejects.toBe(failure);
    expect(calls).toEqual([]);
  });
});
