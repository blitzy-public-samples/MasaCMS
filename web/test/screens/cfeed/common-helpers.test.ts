// Unit tests for the shared cFeed helpers: CFML flags, `utility.displayErrors` and the feed API endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import { cfTruthy, displayErrors, feedApiEndpoint, yesNoFormat, type CfFlag } from '@/screens/cfeed/common';
import {
  adminS2Request,
  anonymousRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';

type SiteRecord = NonNullable<NonNullable<AdminRequestPartial['site']>['record']>;

const PROVIDED = 'https://feeds.example.org/_api/feed/v1/default';

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Record<string, string> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

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

describe('feedApiEndpoint', () => {
  const HOST = 'www.example.com';
  const MIRROR = 'mirror.example.org';
  const CDN = 'cdn.example.org';

  beforeEach(() => {
    useSettings({ MURA_PORT: '8080' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetLegacySettingsForTests();
  });

  /** The S2 admin's request on `default` for `serverName`, with site domain `HOST` and `record` laid over its row. */
  const requestFor = (record: SiteRecord = {}, serverName = HOST, https = false) =>
    adminS2Request({ site: { domain: HOST, record: { Domain: HOST, ...record } }, serverName, https });

  it('returns a provided endpoint as is', () => {
    expect(feedApiEndpoint(anonymousRequest(), PROVIDED)).toBe(PROVIDED);
  });

  it.each([[''], [null], [42]])('builds the endpoint when strategies-content provides %j', (provided) => {
    expect(feedApiEndpoint(requestFor(), provided)).toBe(`http://${HOST}:8080/_api/feed/v1/default`);
  });

  it('throws without a provided endpoint or site data', () => {
    expect(() => feedApiEndpoint(anonymousRequest())).toThrow(Error);
  });

  it('ends with the session site id', () => {
    expect(feedApiEndpoint(siteAdminRequest('tenant-a'))).toBe('http://localhost:8080/_api/feed/v1/tenant-a');
  });

  it.each<[string, SiteRecord, string, boolean, string]>([
    ['the site domain as host', {}, HOST, false, `http://${HOST}:8080`],
    ['the site domain for an unknown host', {}, 'other.example.org', false, `http://${HOST}:8080`],
    ['the site domain for no host', {}, '', false, `http://${HOST}:8080`],
    [
      'a CRLF alias host without case',
      { domainAlias: `alias.example.org\r\n${MIRROR.toUpperCase()}` },
      MIRROR,
      false,
      `http://${MIRROR}:8080`,
    ],
    ['an LF alias host', { domainAlias: `alias.example.org\n${MIRROR}` }, MIRROR, false, `http://${MIRROR}:8080`],
    [
      'an alias host of an enforced primary domain',
      { domainAlias: MIRROR, enforcePrimaryDomain: 1 },
      MIRROR,
      false,
      `http://${HOST}:8080`,
    ],
    ['useSSL', { useSSL: 1 }, HOST, false, `https://${HOST}:8080`],
    ['extranetSSL with NULL useSSL', { useSSL: null, ExtranetSSL: 1 }, HOST, false, `https://${HOST}:8080`],
    ['extranetSSL cleared by useSSL 0', { useSSL: 0, ExtranetSSL: 1 }, HOST, false, `http://${HOST}:8080`],
    ['an HTTPS request', {}, HOST, true, `https://${HOST}:8080`],
    ['a resource domain of a local site', { isremote: null, resourceDomain: CDN }, HOST, false, `http://${HOST}:8080`],
    [
      'the resource domain of a remote site',
      { isremote: 1, resourceDomain: CDN, remoteport: 8443, remotecontext: '/remote' },
      HOST,
      false,
      `http://${CDN}:8080`,
    ],
    [
      'a remote resource domain with resourceSSL',
      { isremote: 1, resourceDomain: CDN, resourceSSL: 1 },
      HOST,
      false,
      `https://${CDN}:8080`,
    ],
    [
      'a remote resource domain with useSSL',
      { isremote: 1, resourceDomain: CDN, useSSL: 1 },
      HOST,
      false,
      `https://${CDN}:8080`,
    ],
    ['a remote resource domain over HTTPS', { isremote: 1, resourceDomain: CDN }, HOST, true, `https://${CDN}:8080`],
    [
      'a remote site port and context',
      { isremote: 1, remoteport: 8443, remotecontext: '/remote' },
      HOST,
      false,
      `http://${HOST}:8443/remote`,
    ],
    [
      'a remote site on port 443',
      { isremote: 1, remoteport: 443, remotecontext: '/remote' },
      HOST,
      false,
      `http://${HOST}/remote`,
    ],
    [
      'a remote site with NULL port and context',
      { isremote: 1, remoteport: null, remotecontext: null },
      HOST,
      false,
      `http://${HOST}`,
    ],
  ])('builds the resource path of %s', (_, record, serverName, https, resourcePath) => {
    expect(feedApiEndpoint(requestFor(record, serverName, https))).toBe(`${resourcePath}/_api/feed/v1/default`);
  });

  it.each<[Record<string, string>, SiteRecord, string]>([
    [{ MURA_PORT: '8080', MURA_CONTEXT: '/cms/' }, {}, `http://${HOST}:8080/cms`],
    [{ MURA_PORT: '80' }, {}, `http://${HOST}`],
    [{ MURA_PORT: '8080', MURA_CONTEXT: '/cms' }, { isremote: 1, resourceDomain: CDN }, `http://${CDN}:8080/cms`],
  ])('applies the global port and context of %j', (vars, record, resourcePath) => {
    useSettings(vars);
    expect(feedApiEndpoint(requestFor(record))).toBe(`${resourcePath}/_api/feed/v1/default`);
  });
});
