// Unit tests for the shared cFeed helpers: CFML flags, `utility.displayErrors` and the feed API endpoint.
import { describe, expect, it } from 'vitest';
import { GatewayDenialError } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import { cfTruthy, displayErrors, legacyFeedEndpoint, yesNoFormat, type CfFlag } from '@/screens/cfeed/common';
import { adminS2Request, type AdminRequestPartial } from '../../helpers/admin-request';
import { LEGACY_SITE_PATHS_KEY, LEGACY_SITE_PATHS_PATH, fakeGatewayClient } from '../../helpers/fake-gateway';

describe('cfTruthy and yesNoFormat', () => {
  it.each<[CfFlag, boolean]>([
    [true, true],
    [1, true],
    [-1, true],
    [0.5, true],
    ['1', true],
    ['2.5', true],
    ['yes', true],
    ['YES', true],
    ['True', true],
    [false, false],
    [0, false],
    ['0', false],
    ['0.0', false],
    ['No', false],
    ['FALSE', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('reads %j as %s', (value, expected) => {
    expect(cfTruthy(value)).toBe(expected);
    expect(yesNoFormat(value)).toBe(expected ? 'Yes' : 'No');
  });

  it.each(['abc', 'maybe'])('throws for the non-boolean %j', (value) => {
    expect(() => cfTruthy(value)).toThrow(TypeError);
    expect(() => yesNoFormat(value)).toThrow(TypeError);
  });
});

describe('displayErrors', () => {
  it.each<[string, Record<string, string>, string]>([
    ['no errors', {}, ''],
    ['one error', { name: 'The name is required.' }, 'The name is required. '],
    ['two errors in order', { name: 'A', maxItems: 'B' }, 'A <br> B '],
    ['a trailing siteID', { name: 'A', siteID: 'default' }, 'A <br> '],
    ['a leading siteid', { siteid: 'default', name: 'A' }, 'A '],
    ['siteID alone', { SiteID: 'default' }, ''],
    ['message markup unencoded', { name: '<strong>A</strong> &amp; B' }, '<strong>A</strong> &amp; B '],
  ])('renders %s', (_, errors, expected) => {
    const markup = displayErrors(errors);
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(expected);
  });
});

describe('legacyFeedEndpoint', () => {
  /** legacy's endpoint, kept from a first touch on another host than the request's. */
  const KEPT = 'https://first.example.org/_api/feed/v1/tenant-a';

  it.each<[string, AdminRequestPartial, string]>([
    ['rc.siteid', { rc: { siteid: 'tenant-a' } }, 'tenant-a'],
    ['the session site for an empty rc.siteid', { rc: { siteid: '' }, session: { siteid: 'tenant-b' } }, 'tenant-b'],
  ])("answers legacy's kept value for %s, read with the request's host facts", async (_case, partial, feedSite) => {
    const gateway = fakeGatewayClient({ [LEGACY_SITE_PATHS_KEY]: { status: 200, body: { feedEndpoint: KEPT } } });
    const req = adminS2Request({ ...partial, httpHost: 'other.example.org:8080', headers: new Headers() });

    await expect(legacyFeedEndpoint(req, gateway)).resolves.toBe(KEPT);
    expect(gateway.calls.map(({ path, query }) => ({ path, query }))).toEqual([
      {
        path: LEGACY_SITE_PATHS_PATH,
        query: { sessionSite: req.session.siteid, host: 'other.example.org:8080', feedSite },
      },
    ]);
  });

  it("throws siteConfig()'s error when neither rc.siteid nor the session names a site, reaching nothing", async () => {
    const gateway = fakeGatewayClient();
    const req = adminS2Request({ rc: { siteid: '' }, session: { siteid: '' } });

    await expect(legacyFeedEndpoint(req, gateway)).rejects.toThrow(
      new Error('The SiteID is not set in the current Mura Scope event.'),
    );
    expect(gateway.calls).toEqual([]);
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
    const gateway = fakeGatewayClient({ [LEGACY_SITE_PATHS_KEY]: { status } });

    await expect(legacyFeedEndpoint(adminS2Request(), gateway)).rejects.toEqual(
      new GatewayDenialError('gateway', 'legacySitePaths', status),
    );
  });

  it('fails on an answer without the endpoint', async () => {
    const gateway = fakeGatewayClient({ [LEGACY_SITE_PATHS_KEY]: { status: 200, body: { themeAssetPath: '/t' } } });

    await expect(legacyFeedEndpoint(adminS2Request(), gateway)).rejects.toThrow(
      new TypeError('legacySitePaths answered no feedEndpoint'),
    );
  });
});
