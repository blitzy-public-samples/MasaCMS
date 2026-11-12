/** Foreign settingsManager.update branches: their detection, and the legacy 503 before any write on both site saves. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LegacyServiceUnavailableError, renderUnavailable } from '@opt2/platform/legacy-compat';
import { TENANT_A, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import {
  SITE_COLUMNS,
  applySet,
  newSiteBean,
  updateColumnValues,
  type SiteData,
} from '../../src/legacy/site-fields.js';
import { RAZUNA_KEYS, detectForeignBranches, type ForeignBranchName } from '../../src/legacy/update-branches.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';

type PostedFields = Readonly<Record<string, string>>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const SITE_ID = TENANT_A.siteId;
const BASE_ID = 'B0000000-0000-0000-0000000000000001';
const TOKEN: PostedFields = { csrf_token: 'T', csrf_token_expires: 'E' };
const SITE_CHANGED_TOPIC = 'programs-sites.site.changed.v1';

/** tenant-a as stored: its own user pools, the umbrella display pool. */
const storedBean = applySet(newSiteBean(BASE_ID), {
  siteid: SITE_ID,
  site: 'Tenant A',
  domain: 'tenant-a.example.test',
  displayPoolID: 'umbrella',
});

/** The stored bean's `programs_sites.site` row: every column, with the values settingsDAO writes for it. */
const STORED_ROW = {
  tenant_id: TENANT_A.tenantId,
  ...Object.fromEntries(SITE_COLUMNS.map(({ targetName }) => [targetName, null])),
  ...updateColumnValues(storedBean),
  siteid: SITE_ID,
  orderno: 1,
  deploy: 1,
  row_version: '1',
};

/** The JSON API 503 the platform renders for a fail-closed condition on an API path. */
const UNAVAILABLE = renderUnavailable(new LegacyServiceUnavailableError(), 'api');

/** One posted update per foreign branch, each running that branch alone. */
const BRANCH_CASES: ReadonlyArray<{ label: string; data: PostedFields; branch: ForeignBranchName }> = [
  { label: 'a new placeholder image', data: { newPlaceholderImg: 'placeholder.png' }, branch: 'placeholder-image' },
  { label: 'a placeholder image delete', data: { deletePlaceholderImg: 'true' }, branch: 'placeholder-image' },
  {
    label: 'filled-in Razuna settings',
    data: { hostName: 'dam.example.test', hostID: '496', apiKey: 'key', damPath: '/demo/dam', servertype: 'cloud' },
    branch: 'razuna',
  },
  { label: 'an uploaded bundle', data: { bundleFile: 'site-bundle.zip' }, branch: 'bundle' },
  { label: 'a server bundle path', data: { serverBundlePath: '/srv/bundles/site-bundle.zip' }, branch: 'bundle' },
  { label: 'a display pool switched onto the site', data: { displayPoolID: SITE_ID }, branch: 'display-pool-copy' },
];

/** Branch names detected for `data` posted for the stored tenant-a. */
function branchesOf(data: SiteData): ForeignBranchName[] {
  return detectForeignBranches(storedBean, { siteid: SITE_ID, ...data }).map(({ branch }) => branch);
}

describe('detectForeignBranches', () => {
  it.each(BRANCH_CASES)('reports only $branch for $label', ({ data, branch }) => {
    expect(branchesOf(data)).toEqual([branch]);
  });

  it.each<{ label: string; data: SiteData }>([
    { label: 'every Razuna key posted empty', data: Object.fromEntries(RAZUNA_KEYS.map((key) => [key, ''])) },
    {
      label: 'the unconfigured Razuna tab, its hidden servertype kept',
      data: { servertype: 'local', hostName: '', hostID: '', apiKey: '', damPath: '' },
    },
  ])('does not report razuna for $label', ({ data }) => {
    expect(branchesOf(data)).toEqual([]);
  });

  it.each<{ label: string; data: SiteData; expected: ForeignBranchName[] }>([
    { label: 'a numeric hostID', data: { hostID: 496 }, expected: ['razuna'] },
    { label: 'a non-empty struct hostName', data: { hostName: { name: 'dam' } }, expected: ['razuna'] },
    { label: 'an empty array hostName beside a damPath', data: { hostName: [], damPath: '/demo/dam' }, expected: [] },
  ])('reads $label as legacy validation does: $expected', ({ data, expected }) => {
    expect(branchesOf(data)).toEqual(expected);
  });

  it.each<{ label: string; data: SiteData }>([
    {
      label: 'site, contact and orderno changed',
      data: { site: 'Renamed', contact: 'web@tenant-a.example.test', orderno: '2' },
    },
    {
      label: 'the Edit Site form, its branch fields posted empty',
      data: { site: 'Renamed', displayPoolID: 'umbrella', newPlaceholderImg: '', bundleFile: '', serverBundlePath: '' },
    },
  ])('reports no branch for $label', ({ data }) => {
    expect(branchesOf(data)).toEqual([]);
  });

  it('reports every branch an update runs, in legacy run order, with its legacy source', () => {
    const data = BRANCH_CASES.reduce<SiteData>((all, { data: one }) => ({ ...all, ...one }), { siteid: SITE_ID });
    expect(detectForeignBranches(storedBean, data)).toEqual([
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

  it('reports no branch while the updated site fails validation', () => {
    expect(detectForeignBranches(newSiteBean(BASE_ID), { bundleFile: 'site-bundle.zip', hostName: 'dam' })).toEqual([]);
  });
});

/** A carried update route and the form it posts for `data`. */
interface Surface {
  name: string;
  url: string;
  form: (data: PostedFields) => PostedFields;
}

const SURFACES: readonly Surface[] = [
  {
    name: 'csettings.updateSite{action=Update}',
    url: `/v1/sites/${SITE_ID}/update`,
    form: (data) => ({ siteid: SITE_ID, action: 'Update', ...TOKEN, ...data }),
  },
  { name: 'JSON API site.save', url: `/_api/json/v1/${SITE_ID}/site`, form: (data) => ({ ...TOKEN, ...data }) },
];

describe.each(SURFACES)('$name', ({ url, form }) => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await buildTestApp();
    harness.db.respond(/FROM "programs_sites"\."site" WHERE/i, [STORED_ROW]);
    harness.db.respond('FROM programs_sites.tenant_registry', [{ tenant_id: TENANT_A.tenantId, site_id: SITE_ID }]);
    harness.client.csrfValid(true);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  /** Posts `data` as an S2 user of tenant-a and checks the answer against the contract. */
  async function post(data: PostedFields) {
    const res = await harness.app.inject({
      method: 'POST',
      url,
      headers: { ...(await headersFor('s2')), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form(data)).toString(),
    });
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'POST',
      path: url,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
    return res;
  }

  it.each(BRANCH_CASES)('answers the legacy 503 for $label and writes nothing', async ({ data }) => {
    const res = await post(data);

    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(UNAVAILABLE.body);
    expect(res.headers.etag).toBe(UNAVAILABLE.headers.ETag);
    expect(harness.db.writes()).toEqual([]);
  });

  it('saves a plain field update, writing the site row, its changelog and its outbox event', async () => {
    const res = await post({ site: 'Renamed', contact: 'web@tenant-a.example.test' });

    expect(res.statusCode).toBe(200);
    expect(harness.db.writesTo('programs_sites.site')).toHaveLength(1);
    expect(harness.db.writesTo('changelog')).toHaveLength(1);
    const outbox = harness.db.writesTo('outbox');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.params).toContain(SITE_CHANGED_TOPIC);
  });
});
