/** The sanitizeHref domain reads of `SitesDomain.hrefDomains` over a recording repository. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { registeredTenants, tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { createSitesDomain, type SitesDomain } from '../../src/domain/sites.js';
import type { ProgramsSitesRepository } from '../../src/repo/repository.js';
import type { SiteRow } from '../../src/repo/tables.js';

vi.mock('@opt2/platform/tenancy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tenancy')>();
  return { ...actual, registeredTenants: vi.fn() };
});

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

function siteRow(siteid: string, overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    tenant_id: tenantIdForSite(siteid),
    siteid,
    site: siteid,
    domain: `${siteid}.example.test`,
    orderno: 1,
    deploy: 1,
    lastdeployment: null,
    baseid: null,
    row_version: '1',
    publicuserpoolid: null,
    privateuserpoolid: null,
    displaypoolid: null,
    filepoolid: null,
    categorypoolid: null,
    contentpoolid: null,
    ...overrides,
  };
}

/** The sites domain's reader over `rows`, registered in site-id order, recording the tenants it opened. */
function readerOver(rows: SiteRow[]): { read: SitesDomain['hrefDomains']; db: TenantDb; opened: string[] } {
  const opened: string[] = [];
  const db: TenantDb = {
    schema: 'programs_sites',
    withTenant: (tenantId, fn) => {
      opened.push(tenantId);
      const reject = (): Promise<never> => Promise.reject(new Error('SQL issued against the fake transaction'));
      const tx: TenantTx = { kind: 'tenant', tenantId, schema: 'programs_sites', query: reject, onCommit: vi.fn() };
      return fn(tx);
    },
    withMetadata: () => Promise.reject(new Error('metadata transaction opened')),
    end: () => Promise.resolve(),
  };
  const repo = { listSites: vi.fn(async (tx: TenantTx) => rows.filter((row) => row.tenant_id === tx.tenantId)) };
  vi.mocked(registeredTenants).mockResolvedValue(
    rows
      .map((row) => ({ siteId: String(row.siteid), tenantId: String(row.tenant_id) }))
      .sort((a, b) => a.siteId.localeCompare(b.siteId)),
  );
  return { read: createSitesDomain({ repo: repo as unknown as ProgramsSitesRepository }).hrefDomains, db, opened };
}

describe('SitesDomain.hrefDomains', () => {
  const rows = (): SiteRow[] => [
    siteRow('default', { domain: ' localhost ', domainalias: 'alias.example\r\nSecond.Alias.test\n\nlocalhost' }),
    siteRow('tenant-a', { domain: 'a.example.test', isremote: 1, resourcedomain: 'cdn.example.test' }),
    siteRow('tenant-b', {
      domain: 'LOCALHOST',
      isremote: 0,
      resourcedomain: 'hidden.example.test',
      domainalias: 'x.test,y.test',
    }),
  ];

  it('lists every site origin domain once, case-sensitively, in site-id order', async () => {
    const { read, db, opened } = readerOver(rows());

    const domains = await read(db, 'tenant-a');

    expect(domains).toEqual({
      allowedDomains: [
        'localhost',
        'alias.example',
        'Second.Alias.test',
        'a.example.test',
        'cdn.example.test',
        'LOCALHOST',
        'x.test',
        'y.test',
      ],
      siteDomain: 'a.example.test',
    });
    expect(opened).toEqual(['default', 'tenant-a', 'tenant-b'].map(tenantIdForSite));
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'GET',
      path: '/v1/href-domains',
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(domains),
    });
  });

  it('skips a resource domain or alias that ListFindNoCase finds among the comma elements', async () => {
    const { read, db } = readerOver([
      siteRow('default', {
        domain: 'a.test,b.test',
        isremote: 1,
        resourcedomain: 'B.TEST',
        domainalias: 'A.test\nx.test,y.test\nY.test',
      }),
    ]);

    expect((await read(db, 'default')).allowedDomains).toEqual(['a.test', 'b.test', 'x.test', 'y.test']);
  });

  it.each([
    ['the named site ignoring case', 'TENANT-B', 'LOCALHOST'],
    ['default for an empty id', '', 'localhost'],
    ['default for an id that names no site', 'nosuch', 'localhost'],
  ])('takes the site domain of %s', async (_label, siteId, siteDomain) => {
    const { read, db } = readerOver(rows());

    expect((await read(db, siteId)).siteDomain).toBe(siteDomain);
  });

  it('fails as getSite does when neither the named site nor default is registered', async () => {
    const { read, db } = readerOver([siteRow('tenant-a')]);

    await expect(read(db, 'nosuch')).rejects.toThrow("Neither site 'nosuch' nor the default site is registered");
  });
});
