import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { createFaultHooks, FAULT_ENV, FAULT_PREFIX, isRosterStep, NO_FAULTS, ROSTER_STEPS } from '../../src/domain/faults.js';
import type { FaultHooks, RosterStep } from '../../src/domain/faults.js';

let kill: MockInstance<typeof process.kill>;

beforeEach(() => {
  // A kill-step boundary signals the current process; the spy records it instead.
  kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** How `promise` stands once pending microtasks and a short timer have run. */
async function settlement(promise: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  return Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => { resolve('pending'); }, 20)),
  ]);
}

/** Asserts every step except `skip` resolves at once. */
async function expectOtherStepsResolve(hooks: FaultHooks, skip?: RosterStep): Promise<void> {
  for (const step of ROSTER_STEPS.filter((s) => s !== skip)) {
    await expect(hooks.at(step)).resolves.toBeUndefined();
  }
}

describe('roster fault constants', () => {
  it('lists the five roster step boundaries in protocol order', () => {
    expect(ROSTER_STEPS).toEqual(['after-start', 'after-prepare', 'after-people-commit', 'after-identity-commit', 'after-done']);
  });

  it('reads kill faults from OPT2_FAULT values prefixed with roster:', () => {
    expect(FAULT_ENV).toBe('OPT2_FAULT');
    expect(FAULT_PREFIX).toBe('roster:');
  });
});

describe('isRosterStep', () => {
  it.each(ROSTER_STEPS)('accepts the step %s', (step) => {
    expect(isRosterStep(step)).toBe(true);
  });

  it.each(['', 'after-commit', 'AFTER-START', ' after-start', 'roster:after-start'])('rejects %j', (value) => {
    expect(isRosterStep(value)).toBe(false);
  });
});

describe('NO_FAULTS', () => {
  it.each(ROSTER_STEPS)('resolves at %s without signalling the process', async (step) => {
    await expect(NO_FAULTS.at(step)).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('createFaultHooks kill step', () => {
  it.each(ROSTER_STEPS)('sends SIGKILL to its own process at %s and never continues past that boundary', async (step) => {
    const hooks = createFaultHooks({}, { [FAULT_ENV]: `${FAULT_PREFIX}${step}` });

    expect(await settlement(hooks.at(step))).toBe('pending');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');

    kill.mockClear();
    await expectOtherStepsResolve(hooks, step);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills at the kill step instead of throwing an error injected at the same step', async () => {
    const hooks = createFaultHooks({ 'after-prepare': new Error('identity unavailable') }, { [FAULT_ENV]: 'roster:after-prepare' });

    expect(await settlement(hooks.at('after-prepare'))).toBe('pending');
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
  });

  it('reads the kill step from process.env when no environment is given', async () => {
    vi.stubEnv(FAULT_ENV, 'roster:after-done');
    const hooks = createFaultHooks();

    expect(await settlement(hooks.at('after-done'))).toBe('pending');
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
  });

  it('reads the environment once, when the hooks are created', async () => {
    const env: NodeJS.ProcessEnv = {};
    const hooks = createFaultHooks({}, env);
    env[FAULT_ENV] = 'roster:after-start';

    await expectOtherStepsResolve(hooks);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'unset', value: undefined },
    { name: 'a step without the roster prefix', value: 'after-start' },
    { name: 'the bare prefix', value: 'roster:' },
    { name: 'an unknown roster step', value: 'roster:after-nothing' },
    { name: 'an upper-case prefix', value: 'ROSTER:after-start' },
    { name: "another package's fault", value: 'timesheets:after-start' },
    { name: 'a step with trailing space', value: 'roster:after-start ' },
  ])('ignores OPT2_FAULT $name and resolves at every step', async ({ value }) => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { [FAULT_ENV]: value };

    await expectOtherStepsResolve(createFaultHooks({}, env));
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('createFaultHooks injected errors', () => {
  it('throws the same injected Error instance each time its step is reached', async () => {
    const error = new Error('prepare rejected');
    const hooks = createFaultHooks({ 'after-prepare': error }, {});

    await expect(hooks.at('after-prepare')).rejects.toBe(error);
    await expect(hooks.at('after-prepare')).rejects.toBe(error);
    await expectOtherStepsResolve(hooks, 'after-prepare');
    expect(kill).not.toHaveBeenCalled();
  });

  it('throws a fresh error from an injected factory each time its step is reached', async () => {
    const factory = vi.fn(() => new Error('identity commit lost'));
    const hooks = createFaultHooks({ 'after-identity-commit': factory }, {});

    const first: unknown = await hooks.at('after-identity-commit').catch((e: unknown) => e);
    const second: unknown = await hooks.at('after-identity-commit').catch((e: unknown) => e);

    expect(first).toBeInstanceOf(Error);
    expect(second).toBeInstanceOf(Error);
    expect(first).not.toBe(second);
    expect((first as Error).message).toBe('identity commit lost');
    expect(factory).toHaveBeenCalledTimes(2);
    await expectOtherStepsResolve(hooks, 'after-identity-commit');
  });

  it('throws each injected error only at its own step', async () => {
    const injected = new Map<RosterStep, Error>(ROSTER_STEPS.map((step) => [step, new Error(step)]));
    const hooks = createFaultHooks(Object.fromEntries(injected), {});

    for (const [step, error] of injected) {
      await expect(hooks.at(step)).rejects.toBe(error);
    }
    expect(kill).not.toHaveBeenCalled();
  });
});
