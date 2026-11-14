/** cfeed admin routes and raw actions (`routes/v1/cfeed.ts`) over a throwaway `content` schema: the gate, list, import preview, update outcomes and fail-closed reads. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, moduleRole } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { WRITE_POSITION_HEADER_LC, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  createService,
  legacyParamsOf,
  loadEnv,
  sendLegacyResponse,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceRequest,
} from '@opt2/platform/service-kit';
import { TENANT_B, assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, pgAvailable, testVerifier } from '@opt2/platform/testing';
import { saveContent } from '../../src/domain/content.js';
import { actorFromClaims } from '../../src/domain/context.js';
import { createFeed, importRemoteFeed, readFeed, type FetchRemote } from '../../src/domain/feeds.js';
import { feedItemRemoteId, parseFeedXml, rssChannelItems } from '../../src/legacy/remote-feed.js';
import { adminCsrf, circuitRouteConfig, requireCircuitAccess } from '../../src/routes/v1/access.js';
import { cfeedRawActions, registerFeedAdminRoutes, type FeedAdminRouteContext } from '../../src/routes/v1/cfeed.js';
import { ADMIN, END, HOME, SITE, SITE_ID, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const SERVICE = 'strategies-content';
const USER = 'U0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const FEED_URL = 'http://feeds.example/rss';
const m = (digits: string): string => moduleRole(`00000000000000000000000000000000${digits}`);
const LIST_LOCATION = `./?muraAction=cFeed.list&siteid=${SITE_ID}`;

/** An RSS 2.0 body behind leading junk, whose first item's pubDate is `firstPubDate`. */
const rss = (firstPubDate: string): string => `junk before the document <?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title><link>http://feeds.example/</link><description>d</description>
<item><title>One</title><link>http://feeds.example/1</link><guid>item-1</guid><pubDate>${firstPubDate}</pubDate><description>&lt;p&gt;First&lt;/p&gt;</description></item>
<item><title>Two &amp; more</title><link>http://feeds.example/2</link><pubDate>Wed, 11 Jun 2025 04:00:00 GMT</pubDate><description>Second</description></item>
<item><title>Three</title><link>http://feeds.example/3</link><guid>item-3</guid><pubDate>Thu, 12 Jun 2025 04:00:00 GMT</pubDate><description>Third</description></item>
</channel></rss>`;
const PUB_DATE = 'Tue, 10 Jun 2025 04:00:00 GMT';

describe.skipIf(!(await pgAvailable()))('cfeed routes', () => {
  let fx: ContentFixture;
  let app: FastifyInstance;
  let remote = { status: 200, body: rss(PUB_DATE) };
  const fetched: string[] = [];
  const consumed: CsrfConsumeRequest[] = [];

  const fetchRemote: FetchRemote = async (url) => {
    fetched.push(url);
    return remote;
  };

  /** The siteid raw routes read, as `./raw.ts` takes it from the url or form fields. */
  const rawSiteId = (request: FastifyRequest): string => String(legacyParamsOf(request).siteid ?? '');

  beforeAll(async () => {
    fx = await createContentFixture('cfeed-routes-test');
    expect((await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 })).errors).toEqual({});
    const ctx = {
      domain: { db: fx.deps.db, repository: fx.deps.repository, clock: fx.deps.clock, config: fx.deps.config },
      clock: fx.deps.clock,
      actorFor: async (request: FastifyRequest) => actorFromClaims(request.opt2Auth.user, 'Feed Admin'),
      fetchRemote,
    } as Pick<FeedAdminRouteContext, 'domain' | 'clock' | 'actorFor' | 'fetchRemote'> as FeedAdminRouteContext;
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8114',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: process.env.TZ ?? 'UTC',
      }),
      clock: fx.deps.clock,
      verifierOverride: testVerifier(SERVICE),
      pool: fx.handle.app,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    registerWritePositionHeader(app);
    await registerFeedAdminRoutes(app, ctx);
    // The raw flow of ./raw.ts: gate, then the CSRF consume where the entry names a context, then the entry.
    for (const [action, spec] of Object.entries(cfeedRawActions)) {
      app.route({
        method: ['GET', 'POST'],
        url: `/v1/raw/cfeed/${action}`,
        config: circuitRouteConfig('cfeed'),
        handler: async (request, reply) => {
          const actor = await requireCircuitAccess(request, ctx, 'cfeed', rawSiteId(request));
          if ('csrfContext' in spec) await adminCsrf(spec.csrfContext).call(app, request, reply);
          const out = await spec.run(request, ctx, actor);
          const location = out.redirect === undefined ? {} : { location: out.redirect };
          return sendLegacyResponse(reply, { status: out.status, headers: { 'content-type': out.contentType, ...location }, body: out.body });
        },
      });
    }
    await app.ready();
    const request = async (req: ServiceRequest) => {
      if (req.service !== 'identity' || req.path !== CSRF_CONSUME_PATH) throw new Error(`unexpected call ${req.service} ${req.path}`);
      const consume = req.json as CsrfConsumeRequest;
      consumed.push(consume);
      return { status: 200, headers: {}, body: { valid: consume.token === 'good' } };
    };
    Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  });

  afterAll(async () => {
    await app?.close();
    await fx?.drop();
  });

  beforeEach(() => {
    remote = { status: 200, body: rss(PUB_DATE) };
    fetched.length = 0;
    consumed.length = 0;
  });

  /** Headers of a user of `site` holding `roles`; null is a caller with no user token. */
  const headersFor = async (roles: readonly string[] | null, site: string = SITE_ID): Promise<Record<string, string>> => {
    const invocation = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}` };
    if (roles === null) return invocation;
    return { ...invocation, authorization: `Bearer ${await mintUserToken({ sub: USER, site, roles: [...roles], s2: roles.includes(Roles.s2) })}` };
  };

  const get = async (url: string, roles: readonly string[] | null = [Roles.s2], site?: string) =>
    app.inject({ method: 'GET', url, headers: await headersFor(roles, site) });

  /** A cfeed.update form post as the edit and list screens send it. */
  const update = async (fields: Record<string, string>, roles: readonly string[] = [Roles.s2]) =>
    app.inject({
      method: 'POST',
      url: `/v1/raw/cfeed/update?siteid=${SITE_ID}`,
      headers: { ...(await headersFor(roles)), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ siteid: SITE_ID, ...fields }).toString(),
    });

  const contract = (response: Awaited<ReturnType<typeof get>>, method: string, path: string): void => {
    const json = /json/.test(String(response.headers['content-type'])) ? response.json() : response.body;
    assertResponseMatchesOpenApi(OPENAPI, { method, path, status: response.statusCode, contentType: response.headers['content-type'], body: json });
  };

  const newFeed = async (name: string, data: Record<string, unknown> = {}) => {
    const bean = await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name, type: 'Local', ...data });
    expect(bean.errors).toEqual({});
    return bean.text('feedid');
  };

  describe('gate', () => {
    const routes = [
      { name: 'listFeeds', url: () => `/v1/sites/${SITE_ID}/feeds`, allowed: 200 },
      { name: 'getFeed', url: () => `/v1/sites/${SITE_ID}/feeds/E0000000-AAAA-BBBB-CCCCDDDDEEEEFFFF`, allowed: 503 },
      { name: 'raw loadsite', url: () => `/v1/raw/cfeed/loadsite?siteid=${SITE_ID}`, allowed: 503 },
      { name: 'raw siteparents', url: () => `/v1/raw/cfeed/siteparents?siteid=${SITE_ID}`, allowed: 503 },
    ];
    const subjects: ReadonlyArray<{ name: string; roles: readonly string[] | null; site?: string; allowed: boolean; denied?: number }> = [
      { name: 'anonymous', roles: null, allowed: false, denied: 401 },
      { name: 'system user', roles: [Roles.systemUser], allowed: false },
      { name: 'collections without site manager', roles: [m('011')], allowed: false },
      { name: 'site manager without collections', roles: [m('000')], allowed: false },
      { name: 'collections and site manager', roles: [m('011'), m('000')], allowed: true },
      { name: 'site admin', roles: [Roles.siteAdmin], allowed: true },
      { name: 's2', roles: [Roles.s2], allowed: true },
      { name: 'another site', roles: [Roles.s2], site: TENANT_B.siteId, allowed: false },
    ];
    const cases = routes.flatMap((route) => subjects.map((subject) => ({ ...route, subject })));

    it.each(cases)('$name answers $subject.name as the cfeed gate decides, whatever feed-manager fields it sends', async ({ url, allowed, subject }) => {
      const expected = subject.allowed ? allowed : (subject.denied ?? 403);
      const separator = url().includes('?') ? '&' : '?';
      for (const target of [url(), `${url()}${separator}hasFeedManager=0&feedManager=0`]) {
        const response = await get(target, subject.roles, subject.site);
        expect(response.statusCode, `${target}: ${response.body}`).toBe(expected);
      }
    });
  });

  it('lists the Local and Remote collections of the site', async () => {
    const local = await newFeed('Local List');
    await newFeed('Remote List', { type: 'Remote', channellink: FEED_URL });
    const response = await get(`/v1/sites/${SITE_ID}/feeds`);
    expect(response.statusCode, response.body).toBe(200);
    contract(response, 'GET', `/v1/sites/${SITE_ID}/feeds`);
    const { rc } = response.json() as { rc: { rsLocal: Array<Record<string, unknown>>; rsRemote: Array<Record<string, unknown>> } };
    expect(rc.rsLocal.map((row) => row.name)).toContain('Local List');
    expect(rc.rsLocal.find((row) => row.feedid === local)).toMatchObject({ type: 'Local', siteid: SITE_ID });
    expect(rc.rsRemote.map((row) => row.name)).toContain('Remote List');
    expect(rc.rsLocal.some((row) => row.name === 'Remote List')).toBe(false);
  });

  it('refuses the edit model after the gate, as its site values have no source here', async () => {
    const response = await get(`/v1/sites/${SITE_ID}/feeds/${await newFeed('Edited')}`);
    expect(response.statusCode).toBe(503);
    contract(response, 'GET', `/v1/sites/${SITE_ID}/feeds/E0000000-AAAA-BBBB-CCCCDDDDEEEEFFFF`);
  });

  describe('import preview', () => {
    let feedId = '';
    const preview = async () => {
      const response = await get(`/v1/sites/${SITE_ID}/feeds/${feedId}/import`);
      return { response, rc: response.statusCode === 200 ? (response.json() as { rc: { feedBean: Record<string, unknown>; items: Array<Record<string, unknown>> } }).rc : undefined };
    };

    beforeAll(async () => {
      feedId = await newFeed('Remote Import', { type: 'Remote', channellink: FEED_URL, parentid: HOME, maxitems: 2 });
    });

    it('offers the first maxItems items of a new feed, in feed order, with their remote ids and markup', async () => {
      const { response, rc } = await preview();
      expect(response.statusCode, response.body).toBe(200);
      contract(response, 'GET', `/v1/sites/${SITE_ID}/feeds/${feedId}/import`);
      expect(fetched).toEqual([FEED_URL]);
      expect([rc?.feedBean.NAME ?? rc?.feedBean.name, rc?.feedBean.VERSION ?? rc?.feedBean.version]).toEqual(['Remote Import', 'RSS 2.0']);
      expect(Array.isArray(rc?.feedBean.PARAMS ?? rc?.feedBean.params)).toBe(true);
      const ids = rssChannelItems(parseFeedXml(rss(PUB_DATE).slice(rss(PUB_DATE).indexOf('<')))).map((item) => feedItemRemoteId(item));
      expect(rc?.items).toEqual([
        { remoteID: ids[0], link: 'http://feeds.example/1', title: 'One', description: '<p>First</p>', isNew: true },
        { remoteID: ids[1], link: 'http://feeds.example/2', title: 'Two & more', description: 'Second', isNew: true },
      ]);
    });

    it('leaves out an imported item whose pubDate is unchanged and marks a changed one as an update', async () => {
      const ids = rssChannelItems(parseFeedXml(rss(PUB_DATE).slice(rss(PUB_DATE).indexOf('<')))).map((item) => feedItemRemoteId(item));
      remote = { status: 200, body: rss(PUB_DATE).slice(rss(PUB_DATE).indexOf('<')) };
      const imported = await importRemoteFeed(fx.deps, ADMIN, SITE, { feedId, remoteId: ids[0] }, fetchRemote);
      expect(imported.saves.map((save) => save.bean.text('remoteid'))).toEqual([ids[0]]);
      remote = { status: 200, body: rss(PUB_DATE) };
      expect((await preview()).rc?.items.map((item) => item.title)).toEqual(['Two & more']);
      remote = { status: 200, body: rss('Fri, 13 Jun 2025 04:00:00 GMT') };
      expect((await preview()).rc?.items.map((item) => [item.title, item.isNew])).toEqual([
        ['One', false],
        ['Two & more', true],
      ]);
    });

    it('compares as text when the imported version holds no date: an empty pubDate matches it, any other offers an update', async () => {
      const body = (pubDate: string): string => `<rss version="2.0"><channel><title>U</title>
<item><title>Undated</title><link>http://undated.example/1</link><guid>undated-1</guid><pubDate>${pubDate}</pubDate><description>u</description></item></channel></rss>`;
      const undatedId = await newFeed('Undated Import', { type: 'Remote', channellink: FEED_URL, parentid: HOME });
      const remoteId = rssChannelItems(parseFeedXml(body(''))).map((item) => feedItemRemoteId(item))[0] ?? '';
      const saved = await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, parentid: HOME, type: 'Page', title: 'Undated', approved: 1, remoteid: remoteId });
      expect(saved.errors).toEqual({});
      const offered = async (pubDate: string) => {
        remote = { status: 200, body: body(pubDate) };
        const response = await get(`/v1/sites/${SITE_ID}/feeds/${undatedId}/import`);
        return (response.json() as { rc: { items: Array<Record<string, unknown>> } }).rc.items.map((item) => [item.title, item.isNew]);
      };
      expect(await offered('')).toEqual([]);
      expect(await offered(PUB_DATE)).toEqual([['Undated', false]]);
    });

    it('fetches and parses an Atom feed but offers nothing', async () => {
      const atomId = await newFeed('Atom Import', { type: 'Remote', channellink: FEED_URL, version: 'atom' });
      const response = await get(`/v1/sites/${SITE_ID}/feeds/${atomId}/import`);
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as { rc: { items: unknown[] } }).rc.items).toEqual([]);
      expect(fetched).toEqual([FEED_URL]);
    });

    it.each([
      ['a non-2xx answer', { status: 404, body: 'gone' }],
      ['a body that is not XML', { status: 200, body: 'no markup at all' }],
    ])('fails the page on %s, as cfhttp throwOnError and parseXML do', async (_label, answer) => {
      remote = answer;
      expect((await preview()).response.statusCode).toBe(500);
    });
  });

  describe('update', () => {
    const feedRow = async (feedId: string) => (await fx.rows('feed', 'feedid = $1', [feedId]))[0];

    it('redirects to the list without writing when no token is sent, and consumes nothing', async () => {
      const feedId = await newFeed('Kept');
      const response = await update({ feedID: feedId, action: 'delete' });
      expect([response.statusCode, response.headers.location, response.body]).toEqual([302, LIST_LOCATION, '']);
      contract(response, 'POST', '/v1/raw/cfeed/update');
      expect(consumed).toEqual([]);
      expect(await feedRow(feedId)).toBeDefined();
    });

    it('validates the token against rc.feedid and redirects without writing when identity refuses it', async () => {
      const feedId = await newFeed('Kept Too');
      const response = await update({ feedID: feedId, action: 'delete', csrf_token: 'bad', csrf_token_expires: '260630120000000' });
      expect([response.statusCode, response.headers.location]).toEqual([302, LIST_LOCATION]);
      expect(consumed.map((call) => call.context)).toEqual([feedId]);
      expect(await feedRow(feedId)).toBeDefined();
    });

    it('deletes the feed for a valid token and redirects with the write position', async () => {
      const feedId = await newFeed('Doomed');
      const response = await update({ feedID: feedId, action: 'delete', csrf_token: 'good', csrf_token_expires: '260630120000000' });
      expect([response.statusCode, response.headers.location]).toEqual([302, LIST_LOCATION]);
      expect(response.headers[WRITE_POSITION_HEADER_LC]).toBeDefined();
      expect(await feedRow(feedId)).toBeUndefined();
    });

    it('adds a collection for a valid token on the GET form of the list links too', async () => {
      const query = new URLSearchParams({ siteid: SITE_ID, feedID: '', action: 'add', name: 'Added Here', type: 'Local', csrf_token: 'good', csrf_token_expires: '1' });
      const response = await app.inject({ method: 'GET', url: `/v1/raw/cfeed/update?${query.toString()}`, headers: await headersFor([Roles.siteAdmin]) });
      expect([response.statusCode, response.headers.location]).toEqual([302, LIST_LOCATION]);
      expect((await readFeed(fx.deps, ADMIN, { siteId: SITE_ID, name: 'Added Here' })).isNew).toBe(0);
    });

    it('refuses a save that fails validation, which wrote nothing, as its form needs site values', async () => {
      const feedId = await newFeed('Valid');
      const response = await update({ feedID: feedId, action: 'update', name: 'Not Saved', lang: '', csrf_token: 'good', csrf_token_expires: '1' });
      expect(response.statusCode).toBe(503);
      contract(response, 'POST', '/v1/raw/cfeed/update');
      expect(await feedRow(feedId)).toMatchObject({ name: 'Valid' });
    });

    it('refuses a compact-display save before writing, and redirects one with a refused token as legacy does', async () => {
      const feedId = await newFeed('Compact');
      const refused = await update({ feedID: feedId, action: 'delete', closeCompactDisplay: 'TRUE', csrf_token: 'good', csrf_token_expires: '1' });
      expect(refused.statusCode).toBe(503);
      expect(await feedRow(feedId)).toBeDefined();
      const rejected = await update({ feedID: feedId, action: 'delete', closeCompactDisplay: 'true' });
      expect([rejected.statusCode, rejected.headers.location]).toEqual([302, LIST_LOCATION]);
    });

    it.each([
      ['without a token', {}],
      ['with a token', { csrf_token: 'good', csrf_token_expires: '1' }],
    ])('fails as legacy does on a request without feedid, %s, consuming nothing', async (_label, token) => {
      const response = await update({ action: 'delete', ...token });
      expect(response.statusCode).toBe(500);
      expect(consumed).toEqual([]);
    });
  });
});
