import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { runCleanup } from '../../src/testing/index.js';

type Outcome = 'resolve' | 'reject' | 'throw';

/** A step that logs when it starts and settles, then resolves, rejects with Error(name) or throws it synchronously. */
function step(log: string[], name: string, outcome: Outcome): () => unknown {
  if (outcome === 'throw') {
    return () => {
      log.push(`${name}:throw`);
      throw new Error(name);
    };
  }
  return async () => {
    log.push(`${name}:start`);
    await setImmediate();
    log.push(`${name}:end`);
    if (outcome === 'reject') throw new Error(name);
  };
}

/** The log a sequential run of `outcomes` produces. */
function sequentialLog(outcomes: readonly Outcome[]): string[] {
  return outcomes.flatMap((outcome, index) => {
    const name = `s${String(index)}`;
    return outcome === 'throw' ? [`${name}:throw`] : [`${name}:start`, `${name}:end`];
  });
}

describe('runCleanup', () => {
  it.each<[string, Outcome[], string[]]>([
    ['an earlier rejection', ['reject', 'resolve', 'resolve'], ['s0']],
    ['an earlier synchronous throw', ['throw', 'resolve', 'resolve'], ['s0']],
    ['several failures', ['resolve', 'reject', 'throw', 'resolve', 'reject'], ['s1', 's2', 's4']],
  ])('runs every step in order after %s and rejects with each failure in step order', async (_label, outcomes, failed) => {
    const log: string[] = [];
    const steps = outcomes.map((outcome, index) => step(log, `s${String(index)}`, outcome));

    const failure = await runCleanup('fixture suite', steps).catch((error: unknown) => error);

    expect(log).toEqual(sequentialLog(outcomes));
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toBe('fixture suite cleanup failed');
    expect(aggregate.errors.map((error: unknown) => (error instanceof Error ? error.message : error))).toEqual(failed);
  });

  it('resolves after running asynchronous, synchronous and value-returning steps in order', async () => {
    const log: string[] = [];
    const steps = [step(log, 's0', 'resolve'), () => log.push('s1'), () => undefined, step(log, 's3', 'resolve')];

    await expect(runCleanup('fixture suite', steps)).resolves.toBeUndefined();
    expect(log).toEqual(['s0:start', 's0:end', 's1', 's3:start', 's3:end']);
  });

  it('resolves with no steps', async () => {
    await expect(runCleanup('fixture suite', [])).resolves.toBeUndefined();
  });
});
