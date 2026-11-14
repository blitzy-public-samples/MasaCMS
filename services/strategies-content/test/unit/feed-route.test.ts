/** `/_api/feed/v1` and `/tasks/feed` over a throwaway `content` schema: dispatch, the feed() decision and the RSS writers against captured legacy bodies. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { parse } from 'yaml';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createLogger, serializeError } from '@opt2/platform/logging';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, assertResponseMatchesOpenApi, pgAvailable, testVerifier, writeTestSecrets, type InjectResponse } from '@opt2/platform/testing';
import { saveContent } from '../../src/domain/content.js';
import type { Actor } from '../../src/domain/context.js';
import { createFeed } from '../../src/domain/feeds.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';
import { RSS_CONTENT_TYPE, feedErrorPacket, renderFeed, type RssFeedView, type RssItemView } from '../../src/legacy/rss.js';
import type { ContentRepository } from '../../src/repo/repository.js';
import { FEED_PATHS, registerFeedRoutes, type FeedRouteContext, type FeedSiteSource } from '../../src/routes/feed.js';
import { SERVICE, testEnv, userHeaders } from '../helpers/app.js';
import { ADMIN, END, HOME, NOW, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/legacy-feed/${name}.xml`, import.meta.url), 'utf8');

const MOZILLA = 'Mozilla/5.0 (X11; Linux x86_64)';
const HTML = 'text/html;charset=UTF-8';
const USER_ID = cfId('U', 9);
const DEFAULT_SITE = 'default';
const DEFAULT_ADMIN: Actor = { ...ADMIN, siteId: DEFAULT_SITE, tenantId: tenantIdForSite(DEFAULT_SITE) };
const ADMIN_B: Actor = { ...ADMIN, siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId };
const EMPTY_20 = '15A1B276-ACD4-B50B-1BB45E4CD40D5435';
const EMPTY_092 = '15A1B3C2-C82D-06B6-EE63DA7D8CA53B05';
const UNKNOWN_FEED = cfId('F', 99);
const FILE_ID = cfId('L', 1);

/** The captured server's URL settings (port 21080, no site id or index file in URLs), as legacy-rss.test reads them. */
const urlsOf = (siteId: string): LegacySiteUrlConfig => ({
  ...SITE.urls,
  siteId,
  domain: siteId === TENANT_B.siteId ? 'b.example' : 'localhost',
  requestDomain: siteId === TENANT_B.siteId ? 'b.example' : 'localhost',
  serverPort: ':21080',
  filePoolId: siteId === TENANT_A.siteId ? TENANT_UMBRELLA.siteId : siteId,
});

const SOURCE: FeedSiteSource = {
  server: { serverPort: ':21080', context: '', indexPath: '' },
  site: async (siteId) => ({ urls: urlsOf(siteId), contact: 'admin@example.com', javaLocale: 'en_US' }),
};

/** The contract path a request URL reaches: the root template, or the wildcard one with any single segment. */
function contractPath(url: string): string {
  const requestPath = url.split('?')[0] ?? url;
  const prefix = FEED_PATHS.find((candidate) => requestPath.startsWith(candidate)) ?? requestPath;
  return requestPath.replace(/\/$/, '') === prefix ? prefix : `${prefix}/p`;
}

describe.skipIf(!(await pgAvailable()))('feed routes', () => {
  let fx: ContentFixture;
  let stateDir: string;
  let app: FastifyInstance;
  let domain: FeedRouteContext['domain'];
  let feedSites: FeedSiteSource | undefined;
  const ctx: FeedRouteContext = {
    get domain() {
      return domain;
    },
    get feedSites() {
      return feedSites;
    },
  };
  const ids: Record<string, string> = {};
  const logLines: Record<string, unknown>[] = [];
  const errorSpies: MockInstance<FastifyRequest['log']['error']>[] = [];

  /** Sends a GET and holds a declared answer to its contract operation. */
  async function get(url: string, headers: Record<string, string> = {}, checkContract = true): Promise<InjectResponse> {
    const res = await app.inject({ method: 'GET', url, headers });
    if (checkContract) {
      assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: contractPath(url), status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    }
    return res;
  }

  const as = (site: string, roles: readonly string[] = [], ua = MOZILLA): Promise<Record<string, string>> =>
    userHeaders({ sub: USER_ID, site, roles }).then((headers) => ({ ...headers, 'user-agent': ua, host: 'localhost:21080' }));

  const page = async (data: Record<string, unknown>): Promise<string> => {
    const saved = await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, type: 'Page', approved: 1, parentid: HOME, ...data });
    expect(saved.errors).toEqual({});
    return saved.bean.contentId();
  };

  const feed = async (actor: Actor, data: Record<string, unknown>): Promise<string> => {
    const bean = await createFeed(fx.deps, actor, { siteid: actor.siteId, type: 'Local', lang: 'en-us', allowhtml: 1, sortby: 'title', sortdirection: 'asc', ...data });
    expect(bean.errors).toEqual({});
    return bean.text('feedid');
  };

  /** The active version row of `contentId`, as the feed query reads it. */
  const versionOf = async (contentId: string): Promise<Record<string, unknown>> => (await fx.rows('content', 'contentid = $1 AND active = 1', [contentId]))[0] ?? {};

  beforeAll(async () => {
    fx = await createContentFixture('feed-route-test');
    feedSites = SOURCE;
    const schema = fx.handle.schema;
    const defaultTenant = tenantIdForSite(DEFAULT_SITE);
    await fx.handle.app.withMetadata((tx) =>
      tx.query(
        `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, public_user_pool_id, private_user_pool_id, category_pool_id, file_pool_id,` +
          ' display_pool_id, content_pool_ids, public_user_pool_tenant, private_user_pool_tenant, category_pool_tenant, file_pool_tenant,' +
          ' display_pool_tenant, content_pool_tenants, domains, aggregate_version, updated_at)' +
          ' VALUES ($1, $2, $1, $1, $1, $1, $1, ARRAY[$1], $2, $2, $2, $2, $2, ARRAY[$2]::uuid[], ARRAY[\'localhost\'], 1, LOCALTIMESTAMP(3))',
        [DEFAULT_SITE, defaultTenant],
      ),
    );
    const umbrella = <T>(fn: (repo: ContentRepository, tx: TenantTx) => Promise<T>): Promise<T> =>
      withGatedTenant(fx.handle.app, TENANT_UMBRELLA.tenantId, (tx) => fn(fx.repo, tx));
    const zeta = await umbrella((repo, tx) => repo.categories.insertCategory(tx, { siteid: TENANT_UMBRELLA.siteId, name: 'Zeta', filename: 'a-first' }));
    const news = await umbrella((repo, tx) => repo.categories.insertCategory(tx, { siteid: TENANT_UMBRELLA.siteId, name: 'News & <Views>', filename: 'b-second' }));
    await umbrella((repo, tx) =>
      repo.files.insertFile(tx, {
        fileid: FILE_ID,
        siteid: TENANT_UMBRELLA.siteId,
        filename: 'brochure.pdf',
        fileext: 'pdf',
        filesize: 77,
        contenttype: 'application',
        contentsubtype: 'pdf',
        created: NOW,
      }),
    );

    await page({ contentid: HOME, parentid: END, title: 'Home' });
    const probe = await page({ type: 'Folder', title: 'Probe' });
    ids.alpha = await page({ parentid: probe, title: 'Alpha', summary: '<p>Hi <a href="/x/">x</a></p>', body: '<p>Alpha body</p>', releasedate: new Date(Date.UTC(2026, 2, 4, 5, 6, 7)) });
    ids.bravo = await page({ parentid: probe, title: 'Bravo', body: '<div>Only <b>body</b> text</div>' });
    ids.charlie = await page({ parentid: probe, title: 'Charlie', summary: 'Charlie summary', fileid: FILE_ID });
    const alpha = await versionOf(ids.alpha);
    for (const [orderNo, category] of [news, zeta].entries()) {
      await withGatedTenant(fx.handle.app, TENANT_A.tenantId, (tx) =>
        fx.repo.categories.setAssignment(tx, {
          categoryId: category.categoryid,
          contentId: ids.alpha ?? '',
          contentHistId: String(alpha.contenthistid),
          isFeature: 0,
          orderNo,
          siteId: SITE_ID,
        }),
      );
    }
    const events = await page({ type: 'Folder', title: 'Events' });
    await page({ parentid: events, display: 2, displaystart: new Date(2026, 0, 1), title: 'Daily', displayinterval: '{"type":"daily","every":1}' });
    const dynamic = await page({ type: 'Folder', title: 'Dynamic' });
    await page({ parentid: dynamic, title: 'Tagged', summary: 'Sum [m]1+1[/m] here' });

    ids.rss20 = await feed(ADMIN, { name: 'News 20', description: 'Desc & co', contentid: probe, version: 'RSS 2.0' });
    ids.rss092 = await feed(ADMIN, { name: 'News 092', description: 'Desc 092', contentid: probe, version: 'RSS 0.920', allowhtml: 0 });
    ids.other = await feed(ADMIN, { name: 'Atom', contentid: probe, version: 'Atom 1.0' });
    ids.restricted = await feed(ADMIN, { name: 'Members', contentid: probe, restricted: 1 });
    ids.events = await feed(ADMIN, { name: 'Events', contentid: events });
    ids.restrictedEvents = await feed(ADMIN, { name: 'Member events', contentid: events, restricted: 1 });
    ids.dynamic = await feed(ADMIN, { name: 'Dynamic', contentid: dynamic });
    ids.pooled = await feed(ADMIN, { name: 'Pooled', contentid: HOME, contentpoolid: `${SITE_ID},${TENANT_B.siteId}` });
    const siteB = { ...SITE, siteId: TENANT_B.siteId, urls: { ...SITE.urls, siteId: TENANT_B.siteId, filePoolId: TENANT_B.siteId } };
    for (const data of [{ contentid: HOME, parentid: END, title: 'Home B' }, { parentid: HOME, title: 'Zulu B' }]) {
      expect((await saveContent(fx.deps, ADMIN_B, siteB, { siteid: TENANT_B.siteId, type: 'Page', approved: 1, ...data })).errors).toEqual({});
    }
    await feed(DEFAULT_ADMIN, { feedid: EMPTY_20, name: 'Empty 20', version: 'RSS 2.0', contentid: cfId('N', 1) });
    await feed(DEFAULT_ADMIN, { feedid: EMPTY_092, name: 'Empty 092', version: 'RSS 0.920', contentid: cfId('N', 1) });

    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-feed-'));
    await writeTestSecrets(stateDir);
    // The service's shutdown ends its pool; the fixture's drop() ends this one.
    const db: TenantDb = {
      schema: fx.handle.app.schema,
      withTenant: (tenantId, fn) => fx.handle.app.withTenant(tenantId, fn),
      withMetadata: (fn) => fx.handle.app.withMetadata(fn),
      end: async () => undefined,
    };
    domain = { ...fx.deps, db };
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, testEnv(stateDir)),
      clock: fx.deps.clock,
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) } }),
    });
    // Captures log.error arguments as the route passes them, before the logger serializes.
    app.addHook('onRequest', (request, _reply, done) => {
      errorSpies.push(vi.spyOn(request.log, 'error'));
      done();
    });
    registerFeedRoutes(app, ctx);
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await fx?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  /** Runs `fn` with the route reading `next` instead of the fixture's deps. */
  async function withDomain<T>(next: Partial<FeedRouteContext['domain']>, fn: () => Promise<T>): Promise<T> {
    const saved = domain;
    domain = { ...saved, ...next };
    try {
      return await fn();
    } finally {
      domain = saved;
    }
  }

  /** The view the writers should receive for `contentId`, from its stored active version. */
  async function expectedItem(contentId: string, view: Pick<RssItemView, 'categories' | 'file'> & { readsBody: boolean }): Promise<RssItemView> {
    const row = await versionOf(contentId);
    const text = (column: string): string | null => (row[column] ?? null) as string | null;
    return {
      contentid: contentId,
      siteid: SITE_ID,
      type: 'Page',
      filename: text('filename'),
      menutitle: text('menutitle'),
      summary: text('summary'),
      body: view.readsBody ? text('body') : null,
      releasedate: (row.releasedate ?? null) as Date | null,
      lastupdate: (row.lastupdate ?? null) as Date | null,
      fileid: text('fileid'),
      categories: view.categories,
      file: view.file,
    };
  }

  const feedView = (feedId: string, fields: Pick<RssFeedView, 'name' | 'description' | 'allowhtml' | 'version'>): RssFeedView => ({
    feedid: feedId,
    siteid: SITE_ID,
    altname: '',
    lang: 'en-us',
    ...fields,
  });

  const renderOptions = (renderContent: boolean) => ({
    site: urlsOf(SITE_ID),
    contact: 'admin@example.com',
    config: SOURCE.server,
    now: NOW,
    renderContent,
    requestHost: 'localhost:21080',
    javaLocale: 'en_US',
  });

  const PDF = { fileext: 'pdf', filesize: 77, contenttype: 'application', contentsubtype: 'pdf' };

  it('declares the four contract operations, public on the service transport with the site checked by the handler', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.includes('/feed'));
    expect(declared).toEqual(
      ['/_api/feed/v1', '/_api/feed/v1/{path}', '/tasks/feed', '/tasks/feed/{path}'].map((template) => {
        const operation = OPENAPI.paths[template]?.['get'] ?? {};
        expect(operation['x-opt2-route-keys']).toEqual(['feed:v1']);
        return { method: 'GET', url: template.replace('{path}', '*'), transport: operation['x-opt2-transport'], public: operation['x-opt2-public'], siteCheck: false };
      }),
    );
  });

  it.each([
    ['no url feedid', '/_api/feed/v1/tenant-a/'],
    ['the legacy endpoint with only a siteid', '/tasks/feed?siteid=tenant-a'],
  ])('answers the unmatched empty page for %s', async (_label, url) => {
    const res = await get(url, {}, false);
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual({ status: 200, type: HTML, body: '' });
  });

  it.each([MOZILLA, 'curl/8.5.0'])('answers a defined, non-public method with the 400 WDDX packet for user agent %s', async (ua) => {
    const res = await get(`/_api/feed/v1/tenant-a/rss20/?feedid=${UNKNOWN_FEED}`, { 'user-agent': ua });
    const expected = feedErrorPacket('invalidMethodCall', ua);
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual({ status: 400, type: expected.contentType, body: expected.body });
  });

  it.each([
    ['an empty feedID, read by no one', '/_api/feed/v1/tenant-a/?feedid=', false],
    ['method=feed, invoked without its params', `/_api/feed/v1/tenant-a/feed/?feedid=${UNKNOWN_FEED}`, false],
    ['an unknown feed', `/_api/feed/v1/tenant-a/?feedid=${UNKNOWN_FEED}`, true],
  ])('answers render404 for %s', async (_label, url, authenticated) => {
    const res = await get(url, authenticated ? await as(SITE_ID) : {});
    expect({ status: res.statusCode, message: res.statusMessage, type: res.headers['content-type'], body: res.body }).toEqual({
      status: 404,
      message: 'Content Not Found',
      type: HTML,
      body: '',
    });
  });

  it.each([
    ['an unregistered site falls back to default', `/_api/feed/v1/nosuch/?feedid=${UNKNOWN_FEED}`, DEFAULT_SITE, 404],
    ['the root endpoint reads the url siteid', `/_api/feed/v1?feedid=${UNKNOWN_FEED}&siteid=tenant-a`, SITE_ID, 404],
    ['the legacy endpoint reads path element 4', `/tasks/feed/x/tenant-a/?feedid=${UNKNOWN_FEED}`, SITE_ID, 404],
    ['a token of another site is refused', `/_api/feed/v1/tenant-a/?feedid=${UNKNOWN_FEED}`, 'tenant-b', 403],
    ['a token of another site is refused on the root endpoint', `/_api/feed/v1?feedid=${UNKNOWN_FEED}&siteid=tenant-a`, 'tenant-b', 403],
    ['a token of another site is refused on the legacy root endpoint', `/tasks/feed?feedid=${UNKNOWN_FEED}&siteid=tenant-a`, 'tenant-b', 403],
    ['a token of another site is refused on the legacy path endpoint', `/tasks/feed/x/tenant-a/?feedid=${UNKNOWN_FEED}`, 'tenant-b', 403],
  ])('site: %s', async (_label, url, site, status) => {
    expect((await get(url, await as(site))).statusCode).toBe(status);
  });

  it('reads a stored feed only for a verified token', async () => {
    expect((await get(`/_api/feed/v1/tenant-a/?feedid=${ids.rss20 ?? ''}`, {}, false)).statusCode).toBe(401);
  });

  it('fails closed where rendering needs site settings no source supplies', async () => {
    feedSites = undefined;
    try {
      expect((await get(`/_api/feed/v1/tenant-a/?feedid=${ids.rss20 ?? ''}`, await as(SITE_ID))).statusCode).toBe(503);
    } finally {
      feedSites = SOURCE;
    }
  });

  it.each([
    ['rss20-empty', EMPTY_20, new Date('2026-11-12T08:54:02Z')],
    ['rss092-empty', EMPTY_092, NOW],
  ])('renders %s byte for byte as captured', async (name, feedId, now) => {
    const res = await withDomain({ clock: fixedClock(now) }, async () => get(`/_api/feed/v1/default/?feedID=${feedId}`, await as(DEFAULT_SITE)));
    expect({ status: res.statusCode, type: res.headers['content-type'], language: res.headers['content-language'], body: res.body }).toEqual({
      status: 200,
      type: RSS_CONTENT_TYPE,
      language: 'en-US',
      body: fixture(name),
    });
  });

  it.each([false, true])('writes RSS 2.0 items with categories by filename and pooled file meta (content=%s)', async (content) => {
    const res = await get(`/_api/feed/v1/tenant-a/?feedid=${ids.rss20 ?? ''}${content ? '&content=true' : ''}`, await as(SITE_ID));
    const items = [
      await expectedItem(ids.alpha ?? '', { categories: ['Zeta', 'News & <Views>'], file: null, readsBody: content }),
      await expectedItem(ids.bravo ?? '', { categories: [], file: null, readsBody: content }),
      await expectedItem(ids.charlie ?? '', { categories: [], file: PDF, readsBody: content }),
    ];
    const expected = renderFeed(feedView(ids.rss20 ?? '', { name: 'News 20', description: 'Desc & co', allowhtml: 1, version: 'RSS 2.0' }), items, renderOptions(content));
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual({ status: 200, type: RSS_CONTENT_TYPE, body: expected.body });
    expect(res.body).toContain('<category>Zeta</category><category>News &amp; &lt;Views&gt;</category>');
    expect(res.body).toContain(`<enclosure url="http://localhost:21080/_api/render/file/?fileID=${FILE_ID}&amp;fileEXT=.pdf" length="77" type="application/pdf" />`);
    expect(res.body.includes('<content:encoded><![CDATA[<p>Alpha body</p>]]></content:encoded>')).toBe(content);
  });

  it.each([MOZILLA, 'curl/8.5.0'])('writes RSS 0.92 text descriptions, falling back to the body, for user agent %s', async (ua) => {
    const res = await get(`/tasks/feed/?siteid=tenant-a&feedid=${ids.rss092 ?? ''}`, await as(SITE_ID, [], ua));
    const items = [
      await expectedItem(ids.alpha ?? '', { categories: [], file: null, readsBody: false }),
      await expectedItem(ids.bravo ?? '', { categories: [], file: null, readsBody: true }),
      await expectedItem(ids.charlie ?? '', { categories: [], file: PDF, readsBody: false }),
    ];
    const expected = renderFeed(feedView(ids.rss092 ?? '', { name: 'News 092', description: 'Desc 092', allowhtml: 0, version: 'RSS 0.920' }), items, renderOptions(false));
    expect({ status: res.statusCode, type: res.headers['content-type'], body: res.body }).toEqual({ status: 200, type: RSS_CONTENT_TYPE, body: expected.body });
    expect(res.body).toContain('<description><![CDATA[Only body text... ]]></description>');
  });

  it('answers another version with the empty page in the site locale', async () => {
    const res = await get(`/_api/feed/v1/tenant-a/?feedid=${ids.other ?? ''}`, await as(SITE_ID), false);
    expect({ status: res.statusCode, type: res.headers['content-type'], language: res.headers['content-language'], body: res.body }).toEqual({
      status: 200,
      type: HTML,
      language: 'en-US',
      body: '',
    });
  });

  it.each([
    ['an anonymous reader without credentials is refused', [], '', 401],
    ['supplied credentials, which only identity could check, fail closed', ['member'], '&username=u&password=p', 503],
    ['a system user of the site private pool reads it', ['system-user'], '', 200],
  ])('restricted feed: %s', async (_label, roles, credentials, status) => {
    const res = await get(`/_api/feed/v1/tenant-a/?feedid=${ids.restricted ?? ''}${credentials}`, await as(SITE_ID, roles));
    expect(res.statusCode).toBe(status);
    if (status === 401) expect(res.body).toBe(feedErrorPacket('authorization', MOZILLA).body);
  });

  it.each([
    ['an unrestricted feed it cannot list fails closed', 'events', 503],
    ['a restricted one is refused first, as legacy refuses it', 'restrictedEvents', 401],
    ['an item with dynamic tags fails closed', 'dynamic', 503],
  ])('%s', async (_label, key, status) => {
    expect((await get(`/_api/feed/v1/tenant-a/?feedid=${ids[key] ?? ''}`, await as(SITE_ID))).statusCode).toBe(status);
  });

  it('builds each content-pool item URL with its own site settings', async () => {
    const pool = (sites: string[]) =>
      fx.handle.app.withMetadata((tx) =>
        tx.query(`UPDATE ${fx.handle.schema}.tenant_registry SET content_pool_ids = $1, content_pool_tenants = $2 WHERE tenant_id = $3`, [
          sites,
          sites.map((site) => tenantIdForSite(site)),
          TENANT_A.tenantId,
        ]),
      );
    await pool([SITE_ID, TENANT_B.siteId]);
    try {
      const res = await get(`/_api/feed/v1/tenant-a/?feedid=${ids.pooled ?? ''}`, await as(SITE_ID));
      expect(res.statusCode).toBe(200);
      expect([...res.body.matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1])).toEqual(['Pooled', 'Dynamic', 'Events', 'Probe', 'Zulu B']);
      expect(res.body).toContain('<link>http://b.example:21080/zulu-b/</link>');
      expect(res.body).toContain('<link>http://localhost:21080/probe/</link>');
    } finally {
      await pool([SITE_ID]);
    }
  });

  it.each([
    ['an unexpected read error as the 500 WDDX packet', 'feedById', new Error('boom'), 500],
    ['an unexpected listing error as the 500 WDDX packet', 'feedContent', new Error('boom'), 500],
    ['a closed gate as the legacy 503', 'feedById', new LegacyServiceUnavailableError('gate closed', 'auto', 'gate-closed'), 503],
  ] as const)('answers %s', async (_label, method, error, status) => {
    const repository: ContentRepository = {
      ...fx.repo,
      feeds: {
        ...fx.repo.feeds,
        [method]: async () => {
          throw error;
        },
      },
    };
    logLines.length = 0;
    errorSpies.length = 0;
    const res = await withDomain({ repository }, async () => get(`/_api/feed/v1/tenant-a/?feedid=${ids.rss20 ?? ''}`, await as(SITE_ID)));
    expect(res.statusCode).toBe(status);
    if (status === 500) expect(res.body).toBe(feedErrorPacket('unhandled', MOZILLA).body);
    expect(errorSpies.flatMap((spy) => spy.mock.calls)).toEqual(status === 500 ? [[{ error: serializeError(error) }, 'unhandled feed error']] : []);
    const unhandled = logLines.filter((line) => line.message === 'unhandled feed error').map(({ severity, error: logged }) => ({ severity, error: logged }));
    expect(unhandled).toEqual(status === 500 ? [{ severity: 'ERROR', error: serializeError(error) }] : []);
  });
});
