/** Outbox input written by the `programs-sites.site.changed.v1` producer. */
import type { EventEnvelope } from '@opt2/platform/events';
import { writeOutbox, type OutboxOrigin } from '@opt2/platform/outbox';
import { SITE_CHANGED_TOPIC, tenantIdForSite, type SiteChangedPayload, type TenantTx } from '@opt2/platform/tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOPIC, writeSiteChanged, type SiteChangedArgs } from '../../src/events/site-changed.js';

vi.mock('@opt2/platform/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/outbox')>();
  return { ...actual, writeOutbox: vi.fn() };
});

const stored = { eventId: 'stored-envelope' } as unknown as EventEnvelope<SiteChangedPayload>;

function tenantTx(): TenantTx {
  return { kind: 'tenant', tenantId: tenantIdForSite('tenant-a'), schema: 'programs_sites' } as unknown as TenantTx;
}

function sitePayload(): SiteChangedPayload {
  return {
    siteId: 'tenant-a',
    publicUserPoolId: 'umbrella',
    privateUserPoolId: 'umbrella',
    categoryPoolId: 'tenant-a',
    filePoolId: 'tenant-a',
    displayPoolId: 'tenant-a',
    contentPoolIds: ['tenant-a'],
    domains: ['a.example.test'],
  };
}

function siteArgs(overrides: Partial<SiteChangedArgs> = {}): SiteChangedArgs {
  return { siteId: 'tenant-a', rowVersion: 1, payload: sitePayload(), ...overrides };
}

/** The outbox input of the only `writeOutbox` call. */
function writtenInput(): Parameters<typeof writeOutbox>[1] {
  expect(writeOutbox).toHaveBeenCalledOnce();
  const call = vi.mocked(writeOutbox).mock.calls[0];
  if (call === undefined) throw new Error('writeOutbox was not called');
  return call[1];
}

beforeEach(() => {
  vi.mocked(writeOutbox).mockReset().mockReturnValue(Promise.resolve(stored));
});

describe('site.changed producer', () => {
  it('publishes on the platform site.changed topic', () => {
    expect(TOPIC).toBe(SITE_CHANGED_TOPIC);
    expect(TOPIC).toBe('programs-sites.site.changed.v1');
  });

  it('writes one state outbox row for the site in the caller transaction and returns its result', async () => {
    const tx = tenantTx();
    const payload = sitePayload();

    const result = writeSiteChanged(tx, { siteId: 'tenant-a', rowVersion: 3, payload, origin: 'target' });

    await expect(result).resolves.toBe(stored);
    expect(writeOutbox).toHaveBeenCalledExactlyOnceWith(tx, {
      topic: 'programs-sites.site.changed.v1',
      kind: 'state',
      aggregateType: 'site',
      aggregateId: 'tenant-a',
      aggregateVersion: 3,
      payload,
      origin: 'target',
    });
    const [calledTx, input] = vi.mocked(writeOutbox).mock.calls[0] ?? [];
    expect(calledTx).toBe(tx);
    expect(input?.payload).toBe(payload);
  });

  it.each<{ rowVersion: bigint | number; aggregateVersion: number }>([
    { rowVersion: 7n, aggregateVersion: 7 },
    { rowVersion: 9_007_199_254_740_991n, aggregateVersion: Number.MAX_SAFE_INTEGER },
    { rowVersion: 1, aggregateVersion: 1 },
    { rowVersion: 42, aggregateVersion: 42 },
  ])('sends row version $rowVersion as the number $aggregateVersion', async ({ rowVersion, aggregateVersion }) => {
    await writeSiteChanged(tenantTx(), siteArgs({ rowVersion }));

    expect(writtenInput().aggregateVersion).toBe(aggregateVersion);
  });

  it.each<{ origin?: OutboxOrigin }>([
    { origin: 'target' },
    { origin: 'legacy-window' },
    { origin: 'migration-feed' },
    { origin: 'backfill' },
    {},
  ])('passes origin $origin through unchanged', async (variant) => {
    await writeSiteChanged(tenantTx(), siteArgs(variant));

    expect(writtenInput().origin).toBe(variant.origin);
  });
});
