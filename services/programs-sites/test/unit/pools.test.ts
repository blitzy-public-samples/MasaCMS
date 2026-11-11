/** Masa pool defaults, the site.changed payload and the content-pool and origin-domain helpers. */
import type { SiteChangedPayload } from '@opt2/platform/tenancy';
import { describe, expect, it } from 'vitest';
import { contentPoolIds, siteChangedPayload, siteDomains } from '../../src/domain/pools.js';
import {
  applySet,
  getSiteValue,
  newSiteBean,
  readBean,
  type SiteBean,
  type SiteData,
  type SiteRow,
} from '../../src/legacy/site-fields.js';
import { SITE } from '../../src/repo/tables.js';

const POOLS = ['privateUserPoolID', 'publicUserPoolID', 'displayPoolID', 'filePoolID', 'categoryPoolID', 'contentPoolID'] as const;

const PAYLOAD_KEYS = Object.keys({
  siteId: true,
  publicUserPoolId: true,
  privateUserPoolId: true,
  categoryPoolId: true,
  filePoolId: true,
  displayPoolId: true,
  contentPoolIds: true,
  domains: true,
} satisfies Record<keyof SiteChangedPayload, true>);

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

const EMPTY_POOLS: SiteData = Object.fromEntries(POOLS.map((pool) => [pool, '']));

// The tenant-a seed site: public user, category, file and display pools in umbrella; its own private and content pools.
const SEED_POOLS: SiteData = {
  publicUserPoolID: 'umbrella',
  categoryPoolID: 'umbrella',
  filePoolID: 'umbrella',
  displayPoolID: 'umbrella',
};

const SEED_EXPECTED = {
  privateUserPoolID: 'tenant-a',
  publicUserPoolID: 'umbrella',
  displayPoolID: 'umbrella',
  filePoolID: 'umbrella',
  categoryPoolID: 'umbrella',
  contentPoolID: 'tenant-a',
};

function poolsOf(bean: SiteBean): Record<string, unknown> {
  return Object.fromEntries(POOLS.map((pool) => [pool, getSiteValue(bean, pool)]));
}

function poolsAll(siteId: string): Record<string, string> {
  return Object.fromEntries(POOLS.map((pool) => [pool, siteId]));
}

/** A stored `programs_sites.site` row as pg returns it: every column NULL except `values`, keyed by target names. */
function storedRow(values: SiteRow): SiteRow {
  return { ...Object.fromEntries(SITE.columns.map((column) => [column.name, null])), ...values };
}

/** Target-name pool columns of a stored row, from bean-cased pool values. */
function poolColumns(pools: SiteData): SiteRow {
  return Object.fromEntries(Object.entries(pools).map(([pool, value]) => [pool.toLowerCase(), value]));
}

function siteBean(data: SiteData): SiteBean {
  return applySet(newSiteBean(), { siteID: 'tenant-b', ...data });
}

describe('applySet pool defaults', () => {
  it.each<{ name: string; data: SiteData }>([
    { name: 'only a site id', data: { siteID: 'tenant-b' } },
    { name: 'empty pools before the site id', data: { ...EMPTY_POOLS, siteID: 'tenant-b' } },
    { name: 'empty pools after the site id', data: { siteID: 'tenant-b', ...EMPTY_POOLS } },
  ])('sets every pool to the site id for $name', ({ data }) => {
    expect(poolsOf(applySet(newSiteBean(), data))).toEqual(poolsAll('tenant-b'));
  });

  it.each<{ name: string; data: SiteData }>([
    { name: 'after', data: { siteID: 'tenant-a', ...SEED_POOLS } },
    { name: 'before', data: { ...SEED_POOLS, siteID: 'tenant-a' } },
  ])('keeps explicit pools given $name the site id and defaults only the empty ones', ({ data }) => {
    expect(poolsOf(applySet(newSiteBean(), data))).toEqual(SEED_EXPECTED);
  });
});

describe('readBean pool defaults', () => {
  it.each<{ name: string; pools: SiteData; expected: Record<string, string> }>([
    { name: 'empty pool columns to the site id', pools: EMPTY_POOLS, expected: poolsAll('tenant-a') },
    {
      name: 'set pool columns and defaults the empty ones',
      pools: { ...EMPTY_POOLS, ...SEED_POOLS },
      expected: SEED_EXPECTED,
    },
  ])('reads $name', ({ pools, expected }) => {
    const bean = readBean(storedRow({ siteid: 'tenant-a', ...poolColumns(pools) }));

    expect(poolsOf(bean)).toEqual(expected);
  });
});

describe('siteChangedPayload', () => {
  const seedRow = storedRow({
    siteid: 'tenant-a',
    ...poolColumns({ ...EMPTY_POOLS, ...SEED_POOLS }),
    contentpoolid: 'tenant-a,umbrella',
    domain: 'a.example',
    domainalias: 'www.a.example',
  });

  it('has exactly the eight SiteChangedPayload keys', () => {
    const payload: SiteChangedPayload = siteChangedPayload(seedRow);

    expect(Object.keys(payload).sort()).toEqual([...PAYLOAD_KEYS].sort());
  });

  it('carries legacy site ids and no tenant UUID', () => {
    const payload = siteChangedPayload(seedRow);
    const strings = Object.values(payload)
      .flat()
      .filter((value): value is string => typeof value === 'string');

    expect(payload).toMatchObject({
      siteId: 'tenant-a',
      publicUserPoolId: 'umbrella',
      privateUserPoolId: 'tenant-a',
      contentPoolIds: ['tenant-a', 'umbrella'],
      domains: ['a.example', 'www.a.example'],
    });
    expect(strings).toHaveLength(10);
    expect(strings.filter((value) => UUID_PREFIX.test(value))).toEqual([]);
  });
});

describe('contentPoolIds', () => {
  it.each<{ name: string; stored: string; expected: string[] }>([
    { name: 'a padded list with empty entries', stored: ' tenant-a, ,umbrella ,, default ', expected: ['tenant-a', 'umbrella', 'default'] },
    { name: 'an empty value', stored: '', expected: ['tenant-b'] },
    { name: 'only a blank entry and a comma', stored: ' , ', expected: ['tenant-b'] },
    { name: 'a single site id', stored: 'umbrella', expected: ['umbrella'] },
  ])('reads $name as $expected', ({ stored, expected }) => {
    expect(contentPoolIds(siteBean({ contentPoolID: stored }))).toEqual(expected);
  });
});

describe('siteDomains', () => {
  const ALIASES = 'b.example\r\nA.EXAMPLE\r\n\r\nc.example';

  it.each<{ name: string; data: SiteData; expected: string[] }>([
    {
      name: 'the domain, the remote resource domain, then each distinct alias line',
      data: { domain: 'a.example', isRemote: 1, resourceDomain: 'cdn.example', domainAlias: ALIASES },
      expected: ['a.example', 'cdn.example', 'b.example', 'c.example'],
    },
    {
      name: 'no resource domain for a site that is not remote',
      data: { domain: 'a.example', isRemote: 0, resourceDomain: 'cdn.example', domainAlias: ALIASES },
      expected: ['a.example', 'b.example', 'c.example'],
    },
    {
      name: 'nothing for an empty resource domain of a remote site',
      data: { domain: 'a.example', isRemote: 1, resourceDomain: '', domainAlias: ALIASES },
      expected: ['a.example', 'b.example', 'c.example'],
    },
  ])('lists $name', ({ data, expected }) => {
    expect(siteDomains(siteBean(data))).toEqual(expected);
  });

  it('takes the site bean alone, so no admin domain enters the list', () => {
    expect(siteDomains).toHaveLength(1);
    expect(siteDomains(siteBean({ domain: 'a.example' }))).toEqual(['a.example']);
  });
});
