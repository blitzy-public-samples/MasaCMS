/** `/_api/feed/v1` and `/tasks/feed`: handleAPIRequest's feed branch (contentServer.cfc:637-648) and feedApiUtility.processRequest (feedApiUtility.cfc:74-277) over the RSS port. */
import { AuthDenial, assertSiteMatches, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  LEGACY_HTML_CONTENT_TYPE,
  LegacyServiceUnavailableError,
  cfIsBoolean,
  cfIsNumeric,
  cfListToArray,
  cfToBoolean,
  cfToNumber,
  fallbackSiteId,
} from '@opt2/platform/legacy-compat';
import { sendLegacyResponse, type FastifyInstance, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import { poolTenantFor, tenantForRegisteredSite, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { actorFromClaims, type Actor, type DomainDeps } from '../domain/context.js';
import { FeedContentUnsupportedError, allowFeed, feedContent, readFeed, type FeedBean, type FeedMemberLookup } from '../domain/feeds.js';
import type { LegacySiteUrlConfig } from '../legacy/content-urls.js';
import {
  decideFeed,
  feedArguments,
  feedErrorPacket,
  feedRenderContent,
  hasDynamicTags,
  renderFeed,
  resolveFeedDispatch,
  type FeedRequest,
  type FeedResponse,
  type RssFeedView,
  type RssFileView,
  type RssItemView,
  type RssServerConfig,
} from '../legacy/rss.js';

/** settingsManager.getSite values the writers print for one site, beyond what `content.tenant_registry` holds. */
export interface FeedRenderSite {
  /** URL settings for the request, whose scheme and host settingsBean `getScheme` and `getWebPath` read. */
  urls: LegacySiteUrlConfig;
  /** settingsBean `contact`, written unescaped as `<webMaster>`. */
  contact: string;
  /** settingsBean `getJavaLocale()`, e.g. `en_US`, which setLocale sends as Content-Language. */
  javaLocale: string;
}

/** Source of the tsettings and configBean values a rendered feed prints; programs-sites owns them. */
export interface FeedSiteSource {
  /** configBean `getServerPort()`, `getContext()` and `getIndexPath()`. */
  server: RssServerConfig;
  site(siteId: string, request: FastifyRequest): Promise<FeedRenderSite>;
}

/** The route context these routes read: a structural subset of `ContentRouteContext`, so this module needs nothing from the `routes/index.ts` that registers it. */
export interface FeedRouteContext {
  domain: Pick<DomainDeps, 'db' | 'repository' | 'clock'>;
  /** Site settings of rendered feeds; without a source, a feed that reaches rendering answers the legacy 503. */
  feedSites?: FeedSiteSource;
}

/** handleAPIRequest's feed endpoints. */
export const FEED_PATHS = ['/_api/feed/v1', '/tasks/feed'] as const;

/** A request's query as Fastify parses it: a repeated key holds an array. */
type FeedQuery = Readonly<Record<string, string | readonly string[] | undefined>>;

type FeedRoute = { Querystring: FeedQuery; Params: { '*'?: string } };

type LegacyResponse = Parameters<typeof sendLegacyResponse>[1];

/** The feed query columns the writers print, as `feedContent` returns them. */
type FeedItemRow = Omit<RssItemView, 'body' | 'categories' | 'file'> & { contenthistid: string | null };

/** The feed version and settings that decide which item values the writer reads. */
interface ItemPlan {
  version: 'rss 2.0' | 'rss 0.920';
  allowHtml: number | null;
  renderContent: boolean;
}

// Public, as legacy serves feeds to any visitor. The handler checks `siteid` itself once it has applied the `default`
// fallback, which the platform's check of every supplied `siteid` would not.
const ROUTE: { opt2: Opt2RouteConfig } = Object.freeze({ opt2: Object.freeze({ public: true, transport: 'service', siteCheck: false }) });

/** handleAPIRequest falling through every endpoint: an empty page. */
const UNMATCHED = Object.freeze({ status: 200, headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE }, body: '' });

// The body of render404 is the site theme's 404 page, which only the CFML runtime renders; status, reason and type are legacy's.
/** contentServer.render404 (contentServer.cfc:505-510). */
const NOT_FOUND = Object.freeze({ status: 404, statusText: 'Content Not Found', headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE }, body: '' });

// configBean `allowOpenFeeds`, read with defaultValue false; no setting of this service carries it.
const ALLOW_OPEN_FEEDS = false;

// Undertow reports `cgi.https` as '' or 'on', never 'Off', so feed()'s https redirect is never taken and the site's
// ExtranetSSL, a programs-sites setting, decides nothing.
const EXTRANET_SSL_UNREAD = false;

// allowFeed's member query reads tusers and tusersmemb, identity units, and identity offers this service no credential
// check, so supplied credentials fail closed. userBean.validate refuses an account without a username
// (userBean.cfc:477), so an empty username matches no member.
const findMember: FeedMemberLookup = async ({ username }) => {
  if (username === '') return false;
  throw new LegacyServiceUnavailableError('Restricted-feed credentials are identity data this service cannot check', 'auto', 'feed-member-lookup');
};

/** A CFML url or form scope of parsed fields: each value as text, a repeated key's values joined with `,`. */
function cfScope(fields: unknown): Record<string, string> {
  if (typeof fields !== 'object' || fields === null || Buffer.isBuffer(fields)) return {};
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)]),
  );
}

/** `scope[name]` as CFML reads it: the key matched without case, a later spelling winning. */
function scopeValue(scope: Readonly<Record<string, string>>, name: string): string | undefined {
  const key = Object.keys(scope).findLast((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : scope[key];
}

/** handleAPIRequest's site: path element 4, else form then url `siteid`, and `default` for a site the registry does not hold. */
async function apiSiteId(db: TenantDb, pathInfo: string, url: Record<string, string>, form: Record<string, string>): Promise<string> {
  const candidate = cfListToArray(pathInfo, '/')[3] ?? scopeValue(form, 'siteid') ?? scopeValue(url, 'siteid') ?? 'default';
  const registered = candidate !== '' && (await tenantForRegisteredSite(db, candidate)) !== null;
  return fallbackSiteId(candidate, () => registered);
}

/** The reader of a feed: the verified claims, whose tenant every feed read runs in. */
function verifiedActor(request: FastifyRequest): Actor {
  const claims = request.opt2Auth.user;
  if (claims === undefined) throw AuthDenial.unauthenticated('missing-credential');
  // Feed reads write nothing, so the full name `actorFor` fetches from identity is never read.
  return actorFromClaims(claims, '');
}

/** CFML `isBoolean(x) and x`. */
function cfBool(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** utility.getRequestHost (utility.cfc:457-468): a non-empty X-Forwarded-Host, else Host, else the server name. */
function requestHost(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-host'];
  if (typeof forwarded === 'string' && forwarded !== '') return forwarded;
  return request.headers.host || request.hostname;
}

/** A port response as the legacy response it is sent as. */
function packet(res: FeedResponse): LegacyResponse {
  const headers: Record<string, string> = { 'Content-Type': res.contentType };
  if (res.contentLanguage !== undefined) headers['Content-Language'] = res.contentLanguage;
  return { status: res.status, headers, body: res.body };
}

/** Runs `fn` in the tenant holding `tenantId`'s `kind` pool, as the registry gives it. */
async function inPoolTenant<T>(db: TenantDb, tenantId: string, kind: 'category' | 'file', fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const pool = await poolTenantFor(db, tenantId, kind);
  if (pool === null) throw new Error(`Tenant ${tenantId} has no site registry entry`);
  return withTenant(db, pool, fn);
}

/** The feed bean values the writers read; feedDAO.read holds a NULL column as ''. */
function feedView(bean: FeedBean): RssFeedView {
  const allowHtml = bean.get('allowhtml');
  return {
    feedid: bean.text('feedid'),
    siteid: bean.text('siteid'),
    name: bean.text('name'),
    altname: bean.text('altname'),
    description: bean.text('description'),
    lang: bean.text('lang'),
    allowhtml: cfIsNumeric(allowHtml) ? cfToNumber(allowHtml) : null,
    version: bean.text('version'),
  };
}

/** contentNavBean.getValue('body') of a feed row: the body of its version (contentNavBean.cfc:140-187). */
async function versionBody(deps: FeedRouteContext['domain'], tenantId: string, contentHistId: string): Promise<string | null> {
  const [version] = await withTenant(deps.db, tenantId, (tx) => deps.repository.content.readVersion(tx, { contentHistId }));
  return version?.body ?? null;
}

/** contentManager.getCategoriesByHistID's names (contentGatewayAdobe.cfc:2139-2152): the version's categories, joined in its category pool, by filename. */
async function categoryNames(deps: FeedRouteContext['domain'], tenantId: string, contentHistId: string): Promise<string[]> {
  const assigned = await withTenant(deps.db, tenantId, (tx) => deps.repository.content.categoryAssignments(tx, { contentHistId }));
  if (assigned.length === 0) return [];
  const categories = await inPoolTenant(deps.db, tenantId, 'category', async (tx) => {
    const found = [];
    for (const assignment of assigned) {
      const [category] = await deps.repository.categories.readCategory(tx, { categoryId: assignment.categoryid });
      if (category !== undefined) found.push(category);
    }
    return found;
  });
  return categories
    .sort((a, b) => (a.filename ?? '').toLowerCase().localeCompare((b.filename ?? '').toLowerCase()))
    .map((category) => category.name ?? '');
}

/** fileManager.readMeta of an item's file, read in its site's file pool; null when no tfiles row has the id. */
async function fileView(deps: FeedRouteContext['domain'], tenantId: string, fileId: string): Promise<RssFileView | null> {
  const meta = await inPoolTenant(deps.db, tenantId, 'file', (tx) => deps.repository.files.readFileMeta(tx, fileId));
  return meta === null ? null : { fileext: meta.fileext, filesize: meta.filesize, contenttype: meta.contenttype, contentsubtype: meta.contentsubtype };
}

/**
 * The writers' view of each feed row (rss20, feedApiUtility.cfc:303-381; rss092, 405-444): the body where it is read,
 * category names for RSS 2.0 and the file meta of an item with a file.
 */
async function itemViews(deps: FeedRouteContext['domain'], rows: readonly FeedItemRow[], plan: ItemPlan): Promise<RssItemView[]> {
  const tenants = new Map<string, string>();
  const tenantOf = async (siteId: string): Promise<string> => {
    let tenantId = tenants.get(siteId.toLowerCase());
    if (tenantId === undefined) {
      const registered = await tenantForRegisteredSite(deps.db, siteId);
      if (registered === null) throw new Error(`Site ${siteId} has no site registry entry`);
      tenantId = registered;
      tenants.set(siteId.toLowerCase(), tenantId);
    }
    return tenantId;
  };
  const views: RssItemView[] = [];
  for (const row of rows) {
    const tenantId = await tenantOf(row.siteid ?? '');
    const summary = row.summary ?? '';
    const rss20 = plan.version === 'rss 2.0';
    const readsBody = rss20 ? plan.renderContent : plan.allowHtml === 0 && summary === '';
    const body = readsBody ? await versionBody(deps, tenantId, row.contenthistid ?? '') : null;
    // setDynamicContent evaluates [m] tags as CFML, which only the legacy runtime renders.
    const dynamicSources = rss20 ? [summary, ...(readsBody ? [body ?? ''] : [])] : [readsBody ? (body ?? '') : summary];
    if (dynamicSources.some(hasDynamicTags)) {
      throw new LegacyServiceUnavailableError(`Content ${row.contentid ?? ''} has dynamic tags only the CFML runtime renders`, 'auto', 'feed-dynamic-content');
    }
    views.push({
      contentid: row.contentid,
      siteid: row.siteid,
      type: row.type,
      filename: row.filename,
      menutitle: row.menutitle,
      summary: row.summary,
      body,
      releasedate: row.releasedate,
      lastupdate: row.lastupdate,
      fileid: row.fileid,
      // rss092 reads the categories too but never prints them.
      categories: rss20 ? await categoryNames(deps, tenantId, row.contenthistid ?? '') : [],
      file: row.fileid ? await fileView(deps, tenantId, row.fileid) : null,
    });
  }
  return views;
}

/** feed()'s render (feedApiUtility.cfc:257-275): the feed in its site's locale through the RSS writers, or an empty page for another version. */
async function renderedFeed(
  ctx: FeedRouteContext,
  request: FastifyRequest,
  feedRequest: FeedRequest,
  bean: FeedBean,
  rows: readonly FeedItemRow[],
): Promise<LegacyResponse> {
  const source = ctx.feedSites;
  // Contact, JavaLocale and the site URL settings are tsettings columns of programs-sites, which neither the site events
  // this service consumes nor any operation open to it carry; rendering with made-up values would diverge silently.
  if (source === undefined) {
    throw new LegacyServiceUnavailableError('Rendered feeds print site settings this service does not hold', 'auto', 'feed-site-settings');
  }
  const feed = feedView(bean);
  const version = (feed.version ?? '').toLowerCase();
  const renderContent = feedRenderContent(feedRequest.url);
  const items =
    version === 'rss 2.0' || version === 'rss 0.920' ? await itemViews(ctx.domain, rows, { version, allowHtml: feed.allowhtml, renderContent }) : [];
  const site = await source.site(feed.siteid ?? '', request);
  const itemSites = new Map<string, LegacySiteUrlConfig>();
  for (const item of items) {
    const siteId = item.siteid ?? '';
    if (!itemSites.has(siteId.toLowerCase())) itemSites.set(siteId.toLowerCase(), (await source.site(siteId, request)).urls);
  }
  return packet(
    renderFeed(feed, items, {
      site: site.urls,
      siteFor: (siteId) => {
        const urls = itemSites.get(siteId.toLowerCase());
        if (urls === undefined) throw new TypeError(`No URL settings for site '${siteId}'`);
        return urls;
      },
      contact: site.contact,
      config: source.server,
      now: ctx.domain.clock.now(),
      renderContent,
      requestHost: requestHost(request),
      javaLocale: site.javaLocale,
    }),
  );
}

/** The stored feed `feedID` names with its reader; null for an empty id or a new bean, which feed() answers with render404. */
async function storedFeed(deps: FeedRouteContext['domain'], request: FastifyRequest, feedId: string): Promise<{ actor: Actor; bean: FeedBean } | null> {
  if (feedId === '') return null;
  const actor = verifiedActor(request);
  const bean = await readFeed(deps, actor, { feedId });
  return bean.isNew === 1 ? null : { actor, bean };
}

/** processRequest from its dispatch on (feedApiUtility.cfc:74-146, 204-277), with allowOpenFeeds off. */
async function processFeedRequest(ctx: FeedRouteContext, request: FastifyRequest, feedRequest: FeedRequest, userAgent: string): Promise<LegacyResponse> {
  const dispatch = resolveFeedDispatch(feedRequest);
  if (dispatch.kind === 'invalidMethodCall') return packet(feedErrorPacket('invalidMethodCall', userAgent));
  const args = feedArguments(dispatch.params);
  const stored = await storedFeed(ctx.domain, request, args.feedId);
  if (stored === null) return NOT_FOUND;
  // getFeed runs before allowFeed: a listing this service cannot reproduce is refused only where legacy would render it.
  const rows = await feedContent(ctx.domain, stored.actor, stored.bean, { tag: args.tag }).catch((err: unknown) => {
    if (err instanceof FeedContentUnsupportedError) return err;
    throw err;
  });
  const decision = decideFeed({
    feedId: args.feedId,
    siteId: args.siteId,
    allowOpenFeeds: ALLOW_OPEN_FEEDS,
    feed: { restricted: cfBool(stored.bean.get('restricted')), version: stored.bean.text('version') },
    cgiHttps: request.protocol === 'https' ? 'on' : '',
    extranetSSL: EXTRANET_SSL_UNREAD,
    allowFeed: await allowFeed(ctx.domain, stored.actor, stored.bean, args, findMember),
  });
  switch (decision.kind) {
    case 'notFound':
      return NOT_FOUND;
    case 'authorization':
    case 'unhandled':
      return packet(feedErrorPacket(decision.kind, userAgent));
    case 'render':
      if (rows instanceof FeedContentUnsupportedError) throw new LegacyServiceUnavailableError(rows.message, 'auto', 'feed-content-unsupported');
      return renderedFeed(ctx, request, feedRequest, stored.bean, rows);
  }
}

/** Answers one feed request: the unmatched page without a url `feedid`, else processRequest's answer for the resolved site. */
async function serveFeed(ctx: FeedRouteContext, prefix: string, request: FastifyRequest<FeedRoute>, reply: FastifyReply): Promise<FastifyReply> {
  const url = cfScope(request.query);
  if (scopeValue(url, 'feedid') === undefined) return sendLegacyResponse(reply, UNMATCHED);
  const wildcard = request.params['*'];
  const pathInfo = wildcard === undefined ? prefix : `${prefix}/${wildcard}`;
  const form = cfScope(request.body);
  const siteId = await apiSiteId(ctx.domain.db, pathInfo, url, form);
  const claims = request.opt2Auth.user;
  if (claims !== undefined) assertSiteMatches(siteId, claims);
  const userAgent = request.headers['user-agent'] ?? '';
  let res: LegacyResponse;
  try {
    res = await processFeedRequest(ctx, request, { pathInfo, url, form, siteId }, userAgent);
  } catch (err) {
    // processRequest's catch (Any): every error but this service's own fail-closed and credential conditions.
    if (err instanceof LegacyServiceUnavailableError || err instanceof AuthDenial) throw err;
    request.log.error({ error: err }, 'unhandled feed error');
    res = packet(feedErrorPacket('unhandled', userAgent));
  }
  return sendLegacyResponse(reply, res);
}

/** Registers `feedApiRootGet`, `feedApiPathGet`, `tasksFeedRootGet` and `tasksFeedPathGet`; legacy authenticates none of them. */
export function registerFeedRoutes(app: FastifyInstance, ctx: FeedRouteContext): void {
  for (const prefix of FEED_PATHS) {
    for (const url of [prefix, `${prefix}/*`]) {
      app.get<FeedRoute>(url, { config: ROUTE }, (request, reply) => serveFeed(ctx, prefix, request, reply));
    }
  }
}
