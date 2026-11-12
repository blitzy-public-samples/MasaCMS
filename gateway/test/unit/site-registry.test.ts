// Tests createSiteRegistry: the first load, case-insensitive lookups, the refresh loop and its failure handling.
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_INTERVAL_MS } from '../../src/cutover/state.js';
import { createSiteRegistry, type SiteRegistry } from '../../src/dispatcher/site-registry.js';

interface Logged {
  obj: object;
  msg: string;
}

/** A registry over `list`, with its logged errors. */
function registryOf(list: () => Promise<string[]>): { registry: SiteRegistry; errors: Logged[] } {
  const errors: Logged[] = [];
  const registry = createSiteRegistry({ list, logger: { error: (obj, msg) => errors.push({ obj, msg }) } });
  return { registry, errors };
}

/** A list whose answers are resolved by hand, in call order. */
function deferredList(): { list: () => Promise<string[]>; answer(index: number, ids: string[]): void; calls: () => number } {
  const pending: Array<(ids: string[]) => void> = [];
  return {
    list: () => new Promise<string[]>((resolve) => pending.push(resolve)),
    answer: (index, ids) => pending[index]?.(ids),
    calls: () => pending.length,
  };
}

const registries: SiteRegistry[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const registry of registries.splice(0)) registry.stop();
  vi.useRealTimers();
});

function track<T extends { registry: SiteRegistry }>(made: T): T {
  registries.push(made.registry);
  return made;
}

describe('createSiteRegistry', () => {
  it.each([
    ['a listed id', 'default', true],
    ['a listed id in another case', 'DEFAULT', true],
    ['a mixed-case listed id in lower case', 'tenant-a', true],
    ['a numeric listed id', '42', true],
    ['an unlisted id', 'nosuchsite', false],
    ['the empty id', '', false],
  ])('after start, %s exists: %s', async (_case, siteId, exists) => {
    const { registry } = track(registryOf(() => Promise.resolve(['default', 'Tenant-A', '42'])));

    await registry.start();

    expect(registry.siteExists(siteId)).toBe(exists);
  });

  it('knows no site before the first load', () => {
    const { registry } = track(registryOf(() => Promise.resolve(['default'])));

    expect(registry.siteExists('default')).toBe(false);
  });

  it('rejects start when the first load fails, and a later start loads', async () => {
    const failure = new ServiceUnavailableError('legacy-bridge', new Error('connect ECONNREFUSED'));
    const list = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(failure).mockResolvedValue(['default']);
    const { registry } = track(registryOf(list));

    await expect(registry.start()).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);

    await registry.start();
    expect(registry.siteExists('default')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('refreshes every REFRESH_INTERVAL_MS, picking up added and removed sites', async () => {
    const answers = [['default'], ['default', 'tenant-b'], ['tenant-b']];
    let call = 0;
    const list = vi.fn(() => Promise.resolve(answers[Math.min(call++, answers.length - 1)] ?? []));
    const { registry } = track(registryOf(list));

    await registry.start();
    expect([registry.siteExists('default'), registry.siteExists('tenant-b')]).toEqual([true, false]);

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect([registry.siteExists('default'), registry.siteExists('tenant-b')]).toEqual([true, true]);

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect([registry.siteExists('default'), registry.siteExists('tenant-b')]).toEqual([false, true]);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('keeps the last snapshot and logs the error without site data when a refresh fails', async () => {
    const failure = new ServiceUnavailableError('legacy-bridge', new Error('legacy bridge site.list answered HTTP 500 serverError'));
    const list = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(['default', 'tenant-a']).mockRejectedValueOnce(failure);
    const { registry, errors } = track(registryOf(list));

    await registry.start();
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);

    expect([registry.siteExists('default'), registry.siteExists('tenant-a')]).toEqual([true, true]);
    expect(errors).toEqual([
      {
        obj: { error: expect.objectContaining({ type: 'ServiceUnavailableError' }) },
        msg: 'legacy site registry refresh failed; keeping the last snapshot',
      },
    ]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('rejects a manual refresh that fails and keeps the snapshot', async () => {
    const list = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(['default']).mockRejectedValueOnce(new Error('timeout'));
    const { registry } = track(registryOf(list));

    await registry.start();
    await expect(registry.refresh()).rejects.toThrow('timeout');

    expect(registry.siteExists('default')).toBe(true);
  });

  it('never lets an earlier-started load replace a later one', async () => {
    const deferred = deferredList();
    const { registry } = track(registryOf(deferred.list));

    const first = registry.refresh();
    const second = registry.refresh();
    deferred.answer(1, ['tenant-b']);
    await second;
    deferred.answer(0, ['default']);
    await first;

    expect([registry.siteExists('default'), registry.siteExists('tenant-b')]).toEqual([false, true]);
  });

  it('stop leaves no timer and no further loads', async () => {
    const list = vi.fn(() => Promise.resolve(['default']));
    const { registry } = track(registryOf(list));

    await registry.start();
    registry.stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 5);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('runs one loop when stopped and restarted while a refresh is in flight', async () => {
    const deferred = deferredList();
    const { registry } = track(registryOf(deferred.list));

    const started = registry.start();
    deferred.answer(0, ['default']);
    await started;
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(deferred.calls()).toBe(2);

    registry.stop();
    const restarted = registry.start();
    deferred.answer(2, ['default']);
    await restarted;
    deferred.answer(1, ['default']);
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(deferred.calls()).toBe(4);
  });

  it('ignores start while already running', async () => {
    const list = vi.fn(() => Promise.resolve(['default']));
    const { registry } = track(registryOf(list));

    await registry.start();
    await registry.start();

    expect(list).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});
