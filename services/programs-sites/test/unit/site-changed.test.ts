/** Outbox input and own-registry apply of the `programs-sites.site.changed.v1` producer. */
import type { EventEnvelope } from '@opt2/platform/events';
import { writeOutbox, type OutboxOrigin } from '@opt2/platform/outbox';
import { SITE_CHANGED_TOPIC, tenantIdForSite, tenantRegistryConsumer, type SiteChangedPayload, type TenantTx } from '@opt2/platform/tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOPIC, lastAnnouncedVersion, writeSiteChanged, type SiteChangedArgs } from '../../src/events/site-changed.js';

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
  vi.restoreAllMocks();
  vi.mocked(writeOutbox).mockReset().mockReturnValue(Promise.resolve(stored));
  vi.spyOn(tenantRegistryConsumer, 'apply').mockResolvedValue(undefined);
});

describe('site.changed producer', () => {
  it('publishes on the platform site.changed topic', () => {
    expect(TOPIC).toBe(SITE_CHANGED_TOPIC);
    expect(TOPIC).toBe('programs-sites.site.changed.v1');
  });

  it('writes one state outbox row for the site in the caller transaction, then applies it to the registry there, and returns its result', async () => {
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
    expect(tenantRegistryConsumer.apply).toHaveBeenCalledExactlyOnceWith(tx, stored);
    expect(vi.mocked(tenantRegistryConsumer.apply)).toHaveBeenCalledAfter(vi.mocked(writeOutbox));
  });

  it('applies nothing to the registry when the outbox stores no envelope', async () => {
    vi.mocked(writeOutbox).mockResolvedValue(null);

    await expect(writeSiteChanged(tenantTx(), siteArgs())).resolves.toBeNull();

    expect(tenantRegistryConsumer.apply).not.toHaveBeenCalled();
  });

  it('rejects with the registry apply failure, so the caller transaction rolls back', async () => {
    const failure = new Error('registry apply failed');
    vi.mocked(tenantRegistryConsumer.apply).mockRejectedValue(failure);

    await expect(writeSiteChanged(tenantTx(), siteArgs())).rejects.toBe(failure);
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

describe('lastAnnouncedVersion', () => {
  it.each<{ version: string | null; expected: bigint }>([
    { version: '57', expected: 57n },
    { version: null, expected: 0n },
  ])('reads $version, the highest site version in the tenant outbox in any letter case, as $expected', async ({ version, expected }) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ version }] });
    const tx = { ...tenantTx(), query } as unknown as TenantTx;

    await expect(lastAnnouncedVersion(tx, 'Tenant-A')).resolves.toBe(expected);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      `SELECT max((envelope->>'aggregateVersion')::bigint)::text AS version FROM "programs_sites".outbox` +
        ' WHERE tenant_id = $1 AND topic = $2 AND lower(ordering_key) = lower($3)',
      [tenantIdForSite('tenant-a'), 'programs-sites.site.changed.v1', 'Tenant-A'],
    );
  });
});
