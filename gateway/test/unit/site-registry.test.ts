// Tests createSiteRegistry: the first load, case-insensitive lookups, request-host binding, the refresh loop and its failure handling.
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import { MemorySpanExporter, SpanKind, activeSpanIds, flushTracing, shutdownTracing, startSpan, startTracing } from '@opt2/platform/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_INTERVAL_MS } from '../../src/cutover/state.js';
import { createSiteRegistry, type HostBinding, type SiteRegistry } from '../../src/dispatcher/site-registry.js';
import type { SiteListing } from '../../src/session/bridge-client.js';

interface Logged {
  obj: object;
  msg: string;
}

/** A registry over the site ids `list` answers, with no domain bindings, and its logged errors. */
function registryOf(list: () => Promise<string[]>): { registry: SiteRegistry; errors: Logged[] } {
  const errors: Logged[] = [];
  const registry = createSiteRegistry({
    list: async () => ({ sites: await list(), bindings: [], adminDomain: '' }),
    logger: { error: (obj, msg) => errors.push({ obj, msg }) },
  });
  return { registry, errors };
}

/** Three sites in bind order, two with aliases, and an admin domain. */
const BOUND: SiteListing = {
  sites: ['default', 'tenant-a', 'tenant-b'],
  bindings: [
    { siteId: 'default', domain: 'localhost', aliases: [] },
    { siteId: 'tenant-a', domain: 'tenant-a.localhost', aliases: ['A.Example', '10'] },
    { siteId: 'tenant-b', domain: 'tenant-b.localhost', aliases: ['b.example'] },
  ],
  adminDomain: 'admin.example',
};

/** A later site whose domain an earlier site's domain contains. */
const NESTED: SiteListing = {
  sites: ['tenant-a', 'tenant-b'],
  bindings: [
    { siteId: 'tenant-a', domain: 'tenant-a.localhost', aliases: [] },
    { siteId: 'tenant-b', domain: 'a.localhost', aliases: [] },
  ],
  adminDomain: '',
};

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
    expect(registry.bindToDomain('localhost')).toBeUndefined();
  });

  it.each<[string, SiteListing, string, HostBinding | undefined]>([
    ['an exact domain', BOUND, 'tenant-b.localhost', { siteId: 'tenant-b', match: 'complete' }],
    ['an alias', BOUND, 'b.example', { siteId: 'tenant-b', match: 'complete' }],
    ['a domain in another case, by CFML ==', BOUND, 'TENANT-B.LocalHost', { siteId: 'tenant-b', match: 'complete' }],
    ['an alias in another case', BOUND, 'a.example', { siteId: 'tenant-a', match: 'complete' }],
    ['a numeric host equal as a number to an alias', BOUND, '10.0', { siteId: 'tenant-a', match: 'complete' }],
    ['an exact domain of a later site over a partial match of an earlier one', NESTED, 'a.localhost', { siteId: 'tenant-b', match: 'complete' }],
    ['a partial match, for the first site containing the host', BOUND, 'tenant', { siteId: 'tenant-a', match: 'partial' }],
    ['a partial match in another case, which find does not make, for the first site', BOUND, 'TENANT', { siteId: 'default', match: 'first' }],
    ['the host without its port', BOUND, 'tenant-b.localhost:8100', { siteId: 'tenant-b', match: 'complete' }],
    ['the admin domain in any case, as --none--', BOUND, 'Admin.Example:443', undefined],
    ['an unbound host, for the first site', BOUND, 'other.test', { siteId: 'default', match: 'first' }],
    ['an empty host, which matches no domain, for the first site', BOUND, '', { siteId: 'default', match: 'first' }],
    ['an empty host on an empty admin domain, as --none--', { ...BOUND, adminDomain: '' }, '', undefined],
    ['any host of an empty registry', { sites: [], bindings: [], adminDomain: '' }, 'tenant-b.localhost', undefined],
  ])('binds %s, with the rule contentServer.bindToDomain(isAdmin=true) binds it by', async (_case, listing, host, bound) => {
    const registry = createSiteRegistry({ list: () => Promise.resolve(listing), logger: { error: () => undefined } });

    await registry.refresh();

    expect(registry.bindToDomain(host)).toEqual(bound);
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

  it('refreshes in a fresh unsampled trace each time, exporting none of the spans the refresh starts', async () => {
    vi.useRealTimers();
    const exporter = new MemorySpanExporter();
    await startTracing({ serviceName: 'site-registry-test', version: '1.0.0', exporter });
    vi.useFakeTimers();
    try {
      // The active span of each load, which starts a client span as the bridge call does.
      const loads: ReturnType<typeof activeSpanIds>[] = [];
      const { registry } = track(
        registryOf(() =>
          startSpan('GET legacy-bridge', SpanKind.CLIENT, () => {
            loads.push(activeSpanIds());
            return ['default'];
          }),
        ),
      );

      await registry.start();
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 2);
      registry.stop();
      await flushTracing();
      const [startup, ...refreshes] = loads;

      expect(exporter.getFinishedSpans().map((span) => span.spanContext().spanId)).toStrictEqual([startup?.spanId]);
      expect(refreshes.map((ids) => ids?.traceSampled)).toStrictEqual([false, false]);
      expect(new Set(refreshes.map((ids) => ids?.traceId)).size).toBe(2);
    } finally {
      vi.useRealTimers();
      await shutdownTracing();
    }
  });
});
