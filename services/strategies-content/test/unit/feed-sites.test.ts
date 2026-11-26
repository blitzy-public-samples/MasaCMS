/** The feed site source: programs-sites' getSite values with configBean's `MURA_<KEY>` settings and the request host, as settingsBean derives a site's URLs. */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from '@opt2/platform/service-kit';
import type { SiteFeedSettings, SitesClient } from '../../src/legacy/sites-client.js';
import { createFeedSiteSource } from '../../src/routes/feed-sites.js';
import { jsonApiLegacySettings } from '../../src/routes/jsonapi.js';

/** A request as Fastify parses it, with only what the source reads. */
const requestOf = (headers: Record<string, string>, protocol: 'http' | 'https' = 'http'): FastifyRequest =>
  ({ headers, protocol }) as unknown as FastifyRequest;

/** tenant-a's stored settings, with `overrides`. */
const settingsOf = (overrides: Partial<SiteFeedSettings> = {}): SiteFeedSettings => ({
  siteID: 'tenant-a',
  contact: 'webmaster@tenant-a.example',
  javaLocale: 'en_GB',
  domain: 'tenant-a.example',
  domainAliases: ['alias.example', 'www.tenant-a.example'],
  enforcePrimaryDomain: false,
  useSSL: false,
  remote: null,
  ...overrides,
});

/** A client answering `answer` for every lookup and recording each id list it is asked. */
function clientOf(answer: (siteIds: readonly string[]) => SiteFeedSettings[]): SitesClient & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    feedSettings: vi.fn(async (siteIds: readonly string[]) => {
      asked.push([...siteIds]);
      return answer(siteIds);
    }),
    // The feed site source reads only the RSS settings.
    customImageSizes: () => Promise.reject(new Error('the feed site source read custom image sizes')),
    configFlags: () => Promise.reject(new Error('the feed site source read site config flags')),
    jsonApiValues: () => Promise.reject(new Error('the feed site source read JSON API site values')),
  };
}

const DEPLOYMENT = jsonApiLegacySettings({ MURA_SITEIDINURLS: 'false', MURA_INDEXFILEINURLS: 'false' });

describe('server settings', () => {
  it.each([
    ['takes the request host port when MURA_PORT is unset', {}, { host: 'tenant-a.example:8080' }, { serverPort: ':8080', context: '', indexPath: '' }],
    ['drops port 80 of the request host', {}, { host: 'tenant-a.example:80' }, { serverPort: '', context: '', indexPath: '' }],
    ['prefers the forwarded host to the hop host', {}, { host: '127.0.0.1:8114', 'x-forwarded-host': 'tenant-a.example:9090' }, { serverPort: ':9090', context: '', indexPath: '' }],
    ['keeps the configured MURA_PORT and MURA_CONTEXT', { MURA_PORT: '8443', MURA_CONTEXT: '/cms/' }, { host: 'tenant-a.example:8080' }, { serverPort: ':8443', context: '/cms', indexPath: '' }],
  ])('%s', (_label, env, headers, expected) => {
    const source = createFeedSiteSource(clientOf(() => []), jsonApiLegacySettings(env));
    expect(source.server(requestOf(headers))).toEqual(expected);
  });
});

describe('site settings', () => {
  it('asks programs-sites once for the distinct ids, ignoring case, and keys each answer by the lower-cased id', async () => {
    const client = clientOf((siteIds) => siteIds.map((siteId) => settingsOf({ siteID: siteId === '' ? 'default' : siteId })));
    const sites = await createFeedSiteSource(client, DEPLOYMENT).sites(['tenant-a', 'TENANT-A', '', 'tenant-b'], requestOf({ host: 'tenant-a.example' }));
    expect(client.asked).toEqual([['tenant-a', '', 'tenant-b']]);
    expect([...sites.keys()]).toEqual(['tenant-a', '', 'tenant-b']);
    expect(sites.get('')?.urls.siteId).toBe('default');
    expect(sites.get('tenant-a')).toMatchObject({ contact: 'webmaster@tenant-a.example', javaLocale: 'en_GB' });
  });

  it.each<[string, Partial<SiteFeedSettings>, Record<string, string>, 'http' | 'https', Record<string, unknown>]>([
    [
      'a local site on its own domain: configBean port, context and URL flags',
      {},
      { host: 'tenant-a.example:8080' },
      'http',
      { scheme: 'http', domain: 'tenant-a.example', requestDomain: 'tenant-a.example', serverPort: ':8080', context: '', siteIdInUrls: false, indexFileInUrls: false, useSSL: false },
    ],
    ['the request host when it is an alias, matched ignoring case', {}, { host: 'ALIAS.example:8080' }, 'http', { requestDomain: 'ALIAS.example', domain: 'tenant-a.example' }],
    ['the primary domain for a host that is no domain of the site', {}, { host: 'other.example' }, 'http', { requestDomain: 'tenant-a.example' }],
    ['the primary domain when it is enforced', { enforcePrimaryDomain: true }, { host: 'alias.example' }, 'http', { requestDomain: 'tenant-a.example' }],
    ['https for a site using SSL', { useSSL: true }, { host: 'tenant-a.example' }, 'http', { scheme: 'https', useSSL: true }],
    ['https for a request the proxy received over HTTPS', {}, { host: 'tenant-a.example', 'x-forwarded-proto': 'https' }, 'http', { scheme: 'https', useSSL: false }],
    ['https for a request received over HTTPS', {}, { host: 'tenant-a.example' }, 'https', { scheme: 'https' }],
    [
      'a remote site: its own domain, port and context, without the site id or index file in URLs',
      { remote: { serverPort: ':8443', context: '/remote' } },
      { host: 'alias.example:8080' },
      'http',
      { requestDomain: 'tenant-a.example', serverPort: ':8443', context: '/remote', siteIdInUrls: false, indexFileInUrls: false },
    ],
  ])('derives the URL settings of %s', async (_label, stored, headers, protocol, expected) => {
    const env = { MURA_SITEIDINURLS: 'true', MURA_INDEXFILEINURLS: 'true' };
    const settings = stored.remote === undefined ? DEPLOYMENT : jsonApiLegacySettings(env);
    const sites = await createFeedSiteSource(clientOf(() => [settingsOf(stored)]), settings).sites(['tenant-a'], requestOf(headers, protocol));
    expect(sites.get('tenant-a')?.urls).toMatchObject({ siteId: 'tenant-a', previewDomain: '', ...expected });
  });

  it('fails when programs-sites answers fewer items than ids it was asked', async () => {
    const source = createFeedSiteSource(clientOf(() => [settingsOf()]), DEPLOYMENT);
    await expect(source.sites(['tenant-a', 'tenant-b'], requestOf({ host: 'tenant-a.example' }))).rejects.toThrow("programs-sites answered no feed settings for site 'tenant-b'");
  });
});
