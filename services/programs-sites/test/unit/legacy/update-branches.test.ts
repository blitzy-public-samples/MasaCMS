/** Unit suite for the pre-write foreign-branch detection in src/legacy/update-branches.ts. */
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';
import { newSiteBean, readBean, type SiteBean, type SiteData } from '../../../src/legacy/site-fields.js';
import {
  RAZUNA_KEYS,
  assertNoForeignBranches,
  detectForeignBranches,
  type ForeignBranchName,
} from '../../../src/legacy/update-branches.js';

/** tenant-a stored with the umbrella display pool. */
const pooled = readBean({ siteid: 'tenant-a', site: 'Tenant A', displaypoolid: 'umbrella' });
/** tenant-a stored as its own display pool. */
const ownPool = readBean({ siteid: 'tenant-a', site: 'Tenant A', displaypoolid: 'tenant-a' });

/** Branch names detected for `data` on `bean`. */
function branches(bean: SiteBean, data: SiteData): ForeignBranchName[] {
  return detectForeignBranches(bean, data).map(({ branch }) => branch);
}

/** An update of the pooled site that keeps its display pool, plus `extra`. */
function pooledUpdate(extra: SiteData): SiteData {
  return { siteID: 'tenant-a', displayPoolID: 'umbrella', ...extra };
}

describe('RAZUNA_KEYS', () => {
  it('lists the razuna settings fields', () => {
    expect(RAZUNA_KEYS).toEqual(['hostName', 'hostID', 'apiKey', 'damPath', 'servertype']);
  });
});

describe('detectForeignBranches', () => {
  it('finds no foreign branch in a plain admin edit', () => {
    const data = pooledUpdate({
      site: 'Renamed', bundleFile: '', serverBundlePath: '', newPlaceholderImg: '', extendSetID: 'set-1',
      action: 'Update',
    });
    expect(detectForeignBranches(pooled, data)).toEqual([]);
  });

  it.each<[string, SiteData, ForeignBranchName[]]>([
    ['a full valid razuna form', { hostName: 'h', hostID: '1', apiKey: 'k', servertype: 'cloud' }, ['razuna']],
    ['only damPath, the stored row supplying the rest', { damPath: '/dam' }, ['razuna']],
    ['only servertype', { servertype: 'local' }, ['razuna']],
    ['keys in any case and a padded servertype', { HOSTNAME: 'h', SERVERTYPE: ' LOCAL ' }, ['razuna']],
    ['a numeric hostID', { hostID: 5 }, ['razuna']],
    ['a non-numeric hostID, which legacy still saves', { hostID: 'abc', apiKey: 'k' }, ['razuna']],
    ['null keys, which set() skips', { hostName: null, damPath: 'x' }, ['razuna']],
    ['a non-empty struct hostName', { hostName: { a: 1 } }, ['razuna']],
    ['the razuna tab posted empty', { servertype: 'local', hostname: '', hostid: '', apikey: '', damPath: '' }, []],
    ['a whitespace-only required field', { hostName: '   ', apiKey: 'k' }, []],
    ['an empty array required field', { hostName: [], damPath: 'x' }, []],
    ['a servertype outside cloud,local', { hostName: 'h', servertype: 'remote' }, []],
    ['an empty servertype', { hostName: 'h', servertype: '' }, []],
    ['a numeric servertype', { hostName: 'h', servertype: 5 }, []],
    ['duplicate key casings, the last winning', { hostName: 'h', HOSTNAME: '', apiKey: 'k' }, []],
  ])('razuna: %s', (_label, extra, expected) => {
    expect(branches(pooled, pooledUpdate(extra))).toEqual(expected);
  });

  it.each<[string, SiteData, ForeignBranchName[]]>([
    ['a new placeholder image', { newPlaceholderImg: '/tmp/upload.png' }, ['placeholder-image']],
    ['a placeholder delete', { deletePlaceholderImg: 'true' }, ['placeholder-image']],
    ['a key in another case', { NEWPLACEHOLDERIMG: 'x' }, ['placeholder-image']],
    ['a complex value, failing closed', { newPlaceholderImg: { file: 'x' } }, ['placeholder-image']],
    ['a whitespace-only new image', { newPlaceholderImg: '   ' }, []],
    ['an empty delete', { deletePlaceholderImg: '' }, []],
  ])('placeholder-image: %s', (_label, extra, expected) => {
    expect(branches(pooled, pooledUpdate(extra))).toEqual(expected);
  });

  it.each<[string, SiteBean, SiteData, ForeignBranchName[]]>([
    ['a switch onto the site itself', pooled, { displayPoolID: 'tenant-a' }, ['display-pool-copy']],
    ['a switch onto the site in another case', pooled, { displayPoolID: 'TENANT-A' }, ['display-pool-copy']],
    ['a cleared pool, defaulted to the site id', pooled, { displayPoolID: '' }, ['display-pool-copy']],
    ['a site already its own pool', ownPool, { displayPoolID: 'tenant-a' }, []],
    ['a site already its own pool, cleared', ownPool, { displayPoolID: '' }, []],
    ['a site staying on another pool', pooled, { displayPoolID: 'umbrella' }, []],
    ['an omitted pool', pooled, {}, []],
    ['a complex pool value', pooled, { displayPoolID: { x: 1 } }, []],
  ])('display-pool-copy: %s', (_label, bean, extra, expected) => {
    expect(branches(bean, { siteID: 'tenant-a', ...extra })).toEqual(expected);
  });

  it.each<[string, SiteData, ForeignBranchName[]]>([
    ['an uploaded bundleFile', { bundleFile: '/tmp/b.zip' }, ['bundle']],
    ['a raw whitespace bundleFile', { bundleFile: '  ' }, ['bundle']],
    ['a serverBundlePath', { serverBundlePath: '/srv/b.zip' }, ['bundle']],
    ['a key in another case', { BUNDLEFILE: 'x' }, ['bundle']],
    ['a numeric zero', { bundleFile: 0 }, ['bundle']],
    ['a null bundleFile', { bundleFile: null }, []],
    ['both posted empty', { bundleFile: '', serverBundlePath: '' }, []],
  ])('bundle: %s', (_label, extra, expected) => {
    expect(branches(pooled, pooledUpdate(extra))).toEqual(expected);
  });

  it('returns every branch in legacy run order with its citation', () => {
    const data = {
      siteID: 'tenant-a', bundleFile: 'b.zip', displayPoolID: 'tenant-a', newPlaceholderImg: 'p.png', hostName: 'h',
    };
    expect(detectForeignBranches(pooled, data)).toEqual([
      { branch: 'razuna', reason: expect.any(String), legacySource: 'core/mura/settings/settingsManager.cfc:271' },
      {
        branch: 'placeholder-image',
        reason: expect.any(String),
        legacySource: 'core/mura/settings/settingsManager.cfc:273-290',
      },
      {
        branch: 'display-pool-copy',
        reason: expect.any(String),
        legacySource: 'core/mura/settings/settingsManager.cfc:293,413-426',
      },
      {
        branch: 'bundle',
        reason: expect.any(String),
        legacySource: 'core/mura/settings/settingsManager.cfc:294,636-680',
      },
    ]);
  });

  it('returns fresh objects and leaves the stored bean unchanged', () => {
    const before = JSON.stringify(pooled.values);
    const [first] = detectForeignBranches(pooled, pooledUpdate({ hostName: 'h', displayPoolID: '' }));
    if (first) first.reason = 'mutated';
    expect(detectForeignBranches(pooled, pooledUpdate({ hostName: 'h' }))[0]?.reason).not.toBe('mutated');
    expect(JSON.stringify(pooled.values)).toBe(before);
  });

  it.each<[string, SiteData]>([
    ['an empty site id', { bundleFile: 'b.zip', hostName: 'h' }],
    ['a reserved site id', { siteID: 'admin', bundleFile: 'b.zip', newPlaceholderImg: 'x' }],
  ])('runs no branch when validation fails: %s', (_label, data) => {
    expect(detectForeignBranches(newSiteBean(), data)).toEqual([]);
  });
});

describe('assertNoForeignBranches', () => {
  it('passes an update without foreign branches', () => {
    expect(() => assertNoForeignBranches(pooled, pooledUpdate({ site: 'Renamed' }))).not.toThrow();
    expect(() => assertNoForeignBranches(newSiteBean(), { bundleFile: 'b.zip' })).not.toThrow();
  });

  it('throws the platform legacy 503 naming the branches', () => {
    let caught: unknown;
    try {
      assertNoForeignBranches(pooled, pooledUpdate({ bundleFile: 'b.zip', hostName: 'h' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(caught).toMatchObject({
      message: 'Site update runs foreign branches: razuna, bundle',
      surface: 'auto',
      reason: 'foreign-branch',
    });
  });
});
