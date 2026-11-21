// Unit tests for the projector-delay fault script.
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { FaultCallError, type RemoteFaults } from '../../src/faults/registry.js';
import { projectorDelay, type ProjectorDelayParams } from '../../src/faults/scripts/projector-delay.js';
import type { FaultEnv } from '../../src/faults/scripts/types.js';

/** An env whose only port in use is a remote that resolves, or rejects with `error`. */
function envWith(error?: unknown) {
  const answer = (): Promise<void> => (error === undefined ? Promise.resolve() : Promise.reject(error));
  const remote = { set: vi.fn<RemoteFaults['set']>(answer), clear: vi.fn<RemoteFaults['clear']>(answer) };
  return { env: { remote } as unknown as FaultEnv, remote };
}

describe('projector-delay fault script', () => {
  it('is the config fault projector-delay and never reconciles', () => {
    expect(projectorDelay.name).toBe('projector-delay');
    expect(projectorDelay.reconciles).toBe(false);
    expect(loadConfig().faults.map((fault) => fault.name)).toContain(projectorDelay.name);
  });

  it.each([
    [{}, { action: 'set' }],
    [{ delayMs: 3000 }, { action: 'set', delayMs: 3000 }],
    [{ action: 'clear' }, { action: 'clear' }],
  ])('parses %j as %j', (input, expected) => {
    expect(projectorDelay.paramsSchema.parse(input)).toStrictEqual(expected);
  });

  it.each([{ delayMs: -1 }, { delayMs: 1.5 }, { delayMs: '3000' }, { action: 'arm' }, { delay: 10 }])('rejects %j', (input) => {
    expect(projectorDelay.paramsSchema.safeParse(input).success).toBe(false);
  });

  it.each<[ProjectorDelayParams, Record<string, number>]>([
    [{ action: 'set' }, {}],
    [{ action: 'set', delayMs: 3000 }, { delayMs: 3000 }],
    [{ action: 'set', delayMs: 0 }, { delayMs: 0 }],
  ])('arms the service fault for %j with params %j and reports toggled', async (params, sent) => {
    const { env, remote } = envWith();
    const output = await projectorDelay.run(env, params);

    expect(remote.set).toHaveBeenCalledExactlyOnceWith('projector-delay', sent);
    expect(remote.clear).not.toHaveBeenCalled();
    const details = { action: 'set', delayMs: params.delayMs };
    expect(output).toStrictEqual({ assertions: [{ name: 'toggled', status: 'pass', detail: details }], details });
  });

  it('disarms the service fault on clear and reports toggled', async () => {
    const { env, remote } = envWith();
    const output = await projectorDelay.run(env, { action: 'clear' });

    expect(remote.clear).toHaveBeenCalledExactlyOnceWith('projector-delay');
    expect(remote.set).not.toHaveBeenCalled();
    expect(output.assertions).toStrictEqual([{ name: 'toggled', status: 'pass', detail: { action: 'clear', delayMs: undefined } }]);
  });

  it.each([
    ['set', new FaultCallError('faultSet', 400, { error: 'invalid' }), 'Migration faultSet answered HTTP 400', 400],
    ['clear', new FaultCallError('faultClear', 404, { error: 'unknown' }), 'Migration faultClear answered HTTP 404', 404],
    ['set', new ServiceUnavailableError('migration', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), 'Service migration unavailable (ECONNREFUSED)', undefined],
    ['clear', 'socket closed', 'socket closed', undefined],
  ] as const)('reports toggled as failed when %s rejects with %s', async (action, error, message, status) => {
    const { env } = envWith(error);
    const delayMs = action === 'set' ? 50 : undefined;
    const output = await projectorDelay.run(env, { action, delayMs });

    expect(output.details).toStrictEqual({ action, delayMs });
    expect(output.assertions).toStrictEqual([{ name: 'toggled', status: 'fail', detail: { action, delayMs, error: message, status } }]);
  });

  it('leaves the delay armed on resume', async () => {
    const { env, remote } = envWith();
    await expect(projectorDelay.resume(env, { action: 'set' })).resolves.toStrictEqual({ steps: [], assertions: [] });
    expect(remote.set).not.toHaveBeenCalled();
    expect(remote.clear).not.toHaveBeenCalled();
  });
});
