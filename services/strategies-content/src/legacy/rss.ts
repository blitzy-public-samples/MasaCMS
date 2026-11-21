/**
 * Masa feed API (`/_api/feed/v1`, `/tasks/feed`; feedApiUtility.cfc): dispatch, the feed() decision, error packets and
 * the RSS 2.0 / 0.92 writers. Pure: the route reads the feed, items, sites and verdicts. Text and headers were captured
 * on Adobe ColdFusion 2023.0.26 (Masa 7.6.1).
 */
import { cfEq, cfIsBoolean, cfListToArray, cfToBoolean, javaTrim } from '@opt2/platform/legacy-compat';
// The byte-exact cfml2wddx port already lives in the domain layer; a second serializer here would duplicate it.
import { cfml2wddx, wddxStruct, type WddxValue } from '../domain/wddx.js';
import type { ContentRow, FeedRow, FileRow } from '../repo/tables.js';
import { contentUrl, type LegacySiteUrlConfig } from './content-urls.js';

/** A feed API request as processRequest reads it (feedApiUtility.cfc:74-118). */
export interface FeedRequest {
  /** `cgi.path_info`: the path after `/index.cfm`. */
  pathInfo: string;
  url: Readonly<Record<string, string>>;
  form: Readonly<Record<string, string>>;
  /** Site the API instance serves: path element 4, else form/url `siteid`, else `default` (contentServer.cfc:637-648). */
  siteId: string;
}

/** Outcome of processRequest's dispatch; `params` is keyed by lower-cased name, as CFML scopes match keys. */
export type FeedDispatch = { kind: 'feed'; params: ReadonlyMap<string, string> } | { kind: 'invalidMethodCall' };

/** feed()'s `cfparam` arguments with their defaults (feedApiUtility.cfc:207-215). */
export interface FeedArguments {
  username: string;
  password: string;
  filter: string;
  feedId: string;
  contentId: string;
  categoryId: string;
  siteId: string;
  maxItems: string;
  tag: string;
}

/** Error types processRequest catches (feedApiUtility.cfc:148-177); `unhandled` is its `catch (Any e)`. */
export type FeedErrorType = 'authorization' | 'invalidParameters' | 'invalidMethodCall' | 'badRequest' | 'invalidTokens' | 'unhandled';

/** Status, headers and body of a feed API response. */
export interface FeedResponse {
  status: number;
  contentType: string;
  /** Set by ACF `setLocale` on the render path (feedApiUtility.cfc:267). */
  contentLanguage?: string;
  body: string;
}

/** Feed bean state feed() tests before rendering; `null` when `feedManager.read(feedID)` finds no feed (a new bean). */
export interface FeedBeanState {
  restricted: boolean;
  version: string;
}

/** Inputs of {@link decideFeed}. */
export interface FeedDecisionInput {
  /** {@link FeedArguments} `feedId`. */
  feedId: string;
  /** {@link FeedArguments} `siteId`. */
  siteId: string;
  /** configBean `allowOpenFeeds` (default false). */
  allowOpenFeeds: boolean;
  /** The feed read by `feedId`, or for an open feed without one the bean built from the URL scope. */
  feed: FeedBeanState | null;
  /** `cgi.https` as ACF reports it: '' over http and 'on' over https under CommandBox/Undertow. */
  cgiHttps: string;
  /** settingsBean `getExtranetSSL()` of the feed's site. */
  extranetSSL: boolean;
  /** feedManager `allowFeed` verdict (feedManager.cfc:470-510). */
  allowFeed: boolean;
}

/** feed()'s branch: legacy 404 page, a caught error, or rendering the feed. */
export type FeedDecision = { kind: 'notFound' } | { kind: 'authorization' } | { kind: 'unhandled' } | { kind: 'render' };

/** The feed bean values the writers read: a tcontentfeeds row, or the bean an open feed builds from the URL. */
export type RssFeedView = Pick<FeedRow, 'feedid' | 'siteid' | 'name' | 'altname' | 'description' | 'lang' | 'allowhtml' | 'version'>;

/** tfiles values of an item's `fileid` (the feed query's join and fileManager.readMeta). */
export type RssFileView = Pick<FileRow, 'fileext' | 'filesize' | 'contenttype' | 'contentsubtype'>;

/** One feed item; `summary` and `body` have already been through setDynamicContent (see {@link hasDynamicTags}). */
export type RssItemView = Pick<
  ContentRow,
  'contentid' | 'siteid' | 'type' | 'filename' | 'menutitle' | 'summary' | 'body' | 'releasedate' | 'lastupdate' | 'fileid'
> & {
  /** Category names of the version, in contentManager.getCategoriesByHistID order. */
  categories: readonly string[];
  /** `null` when no tfiles row matches `fileid`. */
  file: RssFileView | null;
};

/** configBean URL parts the writers read. */
export interface RssServerConfig {
  /** configBean `getServerPort()`: '' or `:<port>`. */
  serverPort: string;
  /** configBean `getContext()`. */
  context: string;
  /** configBean `getIndexPath()`: '' unless index.cfm is in API URLs. */
  indexPath: string;
}

/** Inputs both writers read. */
export interface RssWriteOptions {
  /** URL settings of the feed's site. */
  site: LegacySiteUrlConfig;
  /** URL settings of another site whose content the feed lists (content pools). */
  siteFor?: (siteId: string) => LegacySiteUrlConfig;
  /** The feed site's `contact`, written unescaped. */
  contact: string;
  config: RssServerConfig;
}

/** Inputs of {@link writeRss20}. */
export interface Rss20Options extends RssWriteOptions {
  now: Date;
  /** {@link feedRenderContent} of the URL scope. */
  renderContent: boolean;
}

/** Inputs of {@link writeRss092}. */
export interface Rss092Options extends RssWriteOptions {
  /** utility `getRequestHost()`: X-Forwarded-Host, else Host, else the server name. */
  requestHost: string;
}

/** Inputs of {@link renderFeed}. */
export interface RenderFeedOptions extends Rss20Options, Rss092Options {
  /** settingsBean `getJavaLocale()` of the feed's site, e.g. `en_US`. */
  javaLocale: string;
}

/** Inputs of {@link rssItemDescription}. */
export interface RssDescriptionOptions {
  allowHtml: number | null;
  version: 'RSS 2.0' | 'RSS 0.920';
  /** `<scheme>://<domain><serverPort>` that {@link addCompletePath} prefixes. */
  origin: string;
}

/** Content type of a rendered feed, from its `cfheader` (feedApiUtility.cfc:296,400). */
export const RSS_CONTENT_TYPE = 'text/xml;charset=UTF-8';

const UNRENDERED_CONTENT_TYPE = 'text/html;charset=UTF-8';
const PUBLIC_METHOD = 'feed';
const ERRORS: Readonly<Record<FeedErrorType, readonly [number, string]>> = {
  authorization: [401, 'Insufficient Account Permissions'],
  invalidParameters: [400, 'Insufficient parameters'],
  invalidMethodCall: [400, 'Invalid method call'],
  badRequest: [400, 'Bad Request'],
  invalidTokens: [400, 'Invalid CSRF tokens'],
  unhandled: [500, 'Unhandled Exception'],
};

// isDefined() inside processRequest (probed): the CFC's own and inherited methods (cfobject.cfc and the ACF backport
// include), processRequest's locals, variables-scope keys and scope names. Application, session, server, request,
// client and cookie keys are ACF runtime state the target does not hold, so names beneath them count as undefined.
type Defined = ReadonlyMap<string, Defined> | 'value' | 'any';

const INHERITED_METHODS = [
  'init', 'setValue', 'set', 'getValue', 'get', 'valueExists', 'removeValue', 'isORM', 'getConfigBean',
  'getServiceFactory', 'getBean', 'getEntity', 'getPluginManager', 'getEventManager', 'getCurrentUser', 'getPlugin',
  'injectMethod', 'inject', 'deleteMethod', 'getAsJSON', 'getAsStruct', 'initTracePoint', 'commitTracePoint',
  'invokeMethod', 'hasCustomDatasource', 'getQueryAttrs', 'getQueryService', 'getHTTPService', 'getHTTPAttrs',
  'convertTimezone', 'getJavaTimezone', 'getSession', 'mixin', 'getFeed', 'parseDateArg', 'logError', 'parseXML',
  'esapiEncode',
];
const OWN_METHODS = [
  'getEndPoint', 'getConfig', 'setConfig', 'getEntityConfig', 'setEntityConfig', 'registerMethod', 'processRequest',
  'parseParamsFromPath', 'feed', 'rss20', 'rss092', '_serializeWDDX',
];
const LOCAL_VALUES = ['responseObject', 'result', 'paramsArray', 'pathInfo', 'method', 'httpRequestData', 'sessionData'];
const RUNTIME_SCOPES = ['application', 'arguments', 'cffile', 'cfthread', 'client', 'cookie', 'request', 'server', 'session'];
const VARIABLE_NAME = /^[\p{L}\p{Sc}_][\p{L}\p{M}\p{N}\p{Pc}\p{Sc}]*(?:\.[\p{L}\p{M}\p{N}\p{Pc}\p{Sc}]+)*$/u;

function definedNames(names: Iterable<string>, node: Defined = 'value'): Map<string, Defined> {
  return new Map([...names].map((name) => [name.toLowerCase(), node]));
}

const INHERITED = definedNames(INHERITED_METHODS);
const METHODS = new Map([...INHERITED, ...definedNames(OWN_METHODS)]);
const VARIABLES = new Map<string, Defined>([
  ...METHODS,
  ...definedNames(['siteid', 'endpoint', 'backportdir']),
  ['config', definedNames(['publicMethods'])],
  ['this', METHODS],
]);

/** CFML isDefined(name) as evaluated inside feedApiUtility.processRequest (feedApiUtility.cfc:122). */
function isDefinedInProcessRequest(
  name: string,
  scopes: Readonly<Record<'url' | 'form' | 'params', ReadonlyMap<string, string>>>,
): boolean {
  const locals = new Map<string, Defined>([
    ...definedNames(LOCAL_VALUES),
    ['params', definedNames(scopes.params.keys())],
  ]);
  const root = new Map<string, Defined>([
    ...VARIABLES,
    ...locals,
    ...definedNames(RUNTIME_SCOPES, new Map()),
    ['variables', VARIABLES],
    ['local', locals],
    ['super', INHERITED],
    ['url', definedNames(scopes.url.keys())],
    ['form', definedNames(scopes.form.keys())],
    ['cgi', 'any'],
  ]);
  let node: Defined = root;
  for (const segment of name.toLowerCase().split('.')) {
    if (node === 'any') return true;
    if (node === 'value') return false;
    const next: Defined | undefined = node.get(segment);
    if (next === undefined) return false;
    node = next;
  }
  return true;
}

/** A CFML scope as a map keyed by lower-cased name; a later key overwrites an earlier one, as structAppend does. */
function scopeOf(...sources: ReadonlyArray<Readonly<Record<string, string>>>): Map<string, string> {
  const scope = new Map<string, string>();
  for (const source of sources) for (const [key, value] of Object.entries(source)) scope.set(key.toLowerCase(), value);
  return scope;
}

/** processRequest dispatch (feedApiUtility.cfc:74-146) and parseParamsFromPath's `method` guard (181-200). */
export function resolveFeedDispatch(request: FeedRequest): FeedDispatch {
  const url = scopeOf(request.url);
  const params = scopeOf(request.url, request.form);
  // structAppend(form, params) puts every URL key into the form scope too (feedApiUtility.cfc:85).
  const form = scopeOf(request.form, request.url, request.form);
  const path = cfListToArray(request.pathInfo, '/');
  const [first] = path;
  if (first !== undefined) path.splice(0, cfEq(first, 'tasks') ? 2 : 3);
  const [siteSegment] = path;
  if (siteSegment !== undefined && cfEq(siteSegment, request.siteId)) path.shift();
  if (!params.has('method') && path[0] !== undefined) params.set('method', path[0]);

  const method = params.get('method');
  if (method === undefined || !VARIABLE_NAME.test(method) || !isDefinedInProcessRequest(method, { url, form, params })) {
    return { kind: 'feed', params };
  }
  if (path.slice(2).some((segment) => cfEq(segment, 'method'))) return { kind: 'invalidMethodCall' };
  if (method.toLowerCase() !== PUBLIC_METHOD) return { kind: 'invalidMethodCall' };
  // invoke(this, 'feed', params) passes params as the argument collection, so feed() sees no `arguments.params`.
  return { kind: 'feed', params: new Map() };
}

/** feed()'s `cfparam` defaults over the dispatched params (feedApiUtility.cfc:207-215). */
export function feedArguments(params: ReadonlyMap<string, string>): FeedArguments {
  const param = (name: string, fallback = ''): string => params.get(name) ?? fallback;
  return {
    username: param('username'),
    password: param('password'),
    filter: param('filter'),
    feedId: param('feedid'),
    contentId: param('contentid'),
    categoryId: param('categoryid'),
    siteId: param('siteid'),
    maxItems: param('maxitems', '20'),
    tag: param('tag'),
  };
}

/** Whether rss20 renders item bodies: `url.content` is a true CFML boolean (feedApiUtility.cfc:293). */
export function feedRenderContent(url: Readonly<Record<string, string>>): boolean {
  const value = scopeOf(url).get('content');
  return value !== undefined && cfIsBoolean(value) && cfToBoolean(value);
}

/** Content type processRequest sets before dispatch, used by error packets (feedApiUtility.cfc:106-110). */
export function feedContentType(userAgent: string): string {
  return /mozilla/i.test(userAgent) ? 'text/xml; charset=UTF-8' : 'application/rss+xml; charset=UTF-8';
}

/** ACF `cfwddx action="cfml2wddx"` packet of a value (feedApiUtility.cfc:448-453). */
export function wddxPacket(value: WddxValue): string {
  return cfml2wddx(value);
}

/**
 * WDDX `{error: {message}}` packet of a caught error (feedApiUtility.cfc:148-177). Legacy's 500 packet also carries
 * the cfcatch struct as `stacktrace` (Java frames of the legacy server), which cannot be reproduced and is left out.
 */
export function feedErrorPacket(type: FeedErrorType, userAgent: string): FeedResponse {
  const [status, message] = ERRORS[type];
  return {
    status,
    contentType: feedContentType(userAgent),
    body: wddxPacket(wddxStruct([['error', wddxStruct([['message', message]])]])),
  };
}

/** feed()'s branch before rendering (feedApiUtility.cfc:216-263). */
export function decideFeed(input: FeedDecisionInput): FeedDecision {
  const { feedId, feed } = input;
  if (feedId === '') {
    if (!input.allowOpenFeeds || input.siteId === '') return { kind: 'notFound' };
  } else {
    // The https redirect reads request.rspage, which Masa never sets, so this branch throws into catch (Any).
    if (feed !== null && feed.restricted && input.extranetSSL && input.cgiHttps.toLowerCase() === 'off') {
      return { kind: 'unhandled' };
    }
    if (feed === null) return { kind: 'notFound' };
  }
  if (feed === null) throw new TypeError('An open feed without feedID needs the bean built from the URL scope');
  if (!input.allowOpenFeeds && !input.allowFeed) return { kind: 'authorization' };
  return { kind: 'render' };
}

/** contentRenderer `setDynamicContent`'s tag test (contentRenderer.cfc:2703): ACF `.` matches anything but LF. */
export function hasDynamicTags(s: string): boolean {
  return /(\[sava\]|\[mura\]|\[m\])[^\n]+?(\[\/sava\]|\[\/mura\]|\[\/m\])/i.test(s);
}

const XML_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** ACF `XMLFormat`: the five entities, CR dropped, U+00A0-U+00FF as `&#xhh;`; every other character as is. */
export function cfXmlFormat(s: string): string {
  return s.replace(/[&<>"'\r\u00a0-\u00ff]/g, (ch) => {
    if (ch === '\r') return '';
    return XML_ENTITIES[ch] ?? `&#x${ch.charCodeAt(0).toString(16)};`;
  });
}

/** contentRendererUtility `stripHTML` (contentRendererUtility.cfc:866-869). */
export function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/**
 * contentRendererUtility `addCompletePath` (contentRendererUtility.cfc:871-880): root-relative `src`/`href` values,
 * matched in any case, become `src="<origin>/` and `href="<origin>/`; a single-quoted value keeps its closing quote.
 */
export function addCompletePath(s: string, origin: string): string {
  return s
    .replace(/src="\//gi, () => `src="${origin}/`)
    .replace(/src='\//gi, () => `src="${origin}/`)
    .replace(/href="\//gi, () => `href="${origin}/`)
    .replace(/href='\//gi, () => `href="${origin}/`);
}

/** ACF `GetHttpTimeString`: `EEE, dd MMM yyyy HH:mm:ss GMT` in UTC. */
export function getHttpTimeString(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new RangeError('Invalid date');
  return d.toUTCString();
}

/** An item description as rss20 (feedApiUtility.cfc:348-355) and rss092 (413-422) prepare it. */
export function rssItemDescription(summary: string, body: string, opts: RssDescriptionOptions): string {
  const text = opts.version === 'RSS 2.0' ? javaTrim(summary) : summary;
  if (opts.allowHtml !== 0) return addCompletePath(text, opts.origin);
  const source = opts.version === 'RSS 0.920' && text === '' ? body : text;
  return `${stripHtml(source).slice(0, 200)}...`;
}

/**
 * A `cfsavecontent` buffer under ACF whitespace management (captured): template text is written as is, except that
 * a whitespace-only run between two tags is written as one space, and only after a non-whitespace character.
 */
class SaveContent {
  private out = '';

  text(...parts: string[]): this {
    this.out += parts.join('');
    return this;
  }

  whitespace(): this {
    const last = this.out.at(-1);
    if (last !== undefined && !' \t\n\r\f\v'.includes(last)) this.out += ' ';
    return this;
  }

  toString(): string {
    return this.out;
  }
}

/** feedBean `renderName` (feedBean.cfc:607-613). */
function renderName(feed: RssFeedView): string {
  return feed.altname ? feed.altname : (feed.name ?? '');
}

/** The settingsBean of an item's site, as `settingsManager.getSite(item.siteid)` resolves it. */
function itemSite(item: RssItemView, opts: RssWriteOptions): LegacySiteUrlConfig {
  const siteId = item.siteid ?? '';
  if (siteId.toLowerCase() === opts.site.siteId.toLowerCase()) return opts.site;
  if (opts.siteFor === undefined) throw new TypeError(`No URL settings for site '${siteId}'`);
  return opts.siteFor(siteId);
}

/** The item date the writers print: releaseDate when set, else lastUpdate (feedApiUtility.cfc:357-361). */
function itemPubDate(item: RssItemView): Date {
  const date = item.releasedate ?? item.lastupdate;
  if (date === null) throw new TypeError(`Content ${item.contentid ?? ''} has no lastUpdate`);
  return date;
}

/** `/_api/render/file/` URL of an item's file, before XMLFormat (feedApiUtility.cfc:376,438). */
function fileRenderUrl(scheme: string, site: LegacySiteUrlConfig, config: RssServerConfig, item: RssItemView): string {
  const origin = `${scheme}://${site.domain}${config.serverPort}${config.context}${config.indexPath}`;
  return `${origin}/_api/render/file/?fileID=${item.fileid ?? ''}&fileEXT=.${item.file?.fileext ?? ''}`;
}

/** The `<enclosure>` element of an item's file. */
function enclosure(url: string, file: RssFileView | null): string {
  const length = file === null || file.filesize === null ? '' : String(file.filesize);
  const type = `${file?.contenttype ?? ''}/${file?.contentsubtype ?? ''}`;
  return `<enclosure url="${cfXmlFormat(url)}" length="${length}" type="${type}" />`;
}

/** rss20 (feedApiUtility.cfc:279-383). */
export function writeRss20(feed: RssFeedView, items: readonly RssItemView[], opts: Rss20Options): string {
  const { site, config } = opts;
  const siteRoot = `${site.scheme}://${site.domain}${config.serverPort}${config.context}`;
  const out = new SaveContent().text(
    '<?xml version="1.0" ?>\n',
    '\t\t<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">\n',
    '\t\t\t<channel>\n',
    '\t\t\t\t<title>', cfXmlFormat(renderName(feed)), '</title>\n',
    '\t\t\t\t<link>', siteRoot, '</link>\n',
    '\t\t\t\t<description>', cfXmlFormat(feed.description ?? ''), '</description>\n',
    '\t\t\t\t<webMaster>', opts.contact, '</webMaster>\n',
    '\t\t\t\t<generator>https://www.masacms.com</generator>\n',
    '\t\t\t\t<pubDate>', getHttpTimeString(opts.now), '</pubDate>\n',
    '\t\t\t\t<language>', cfXmlFormat(feed.lang ?? ''), '</language>\n',
    '\t\t\t\t<atom:link href="', siteRoot, config.indexPath, '/_api/feed/v1/', cfXmlFormat(feed.siteid ?? ''),
    '/?feedID=', cfXmlFormat(feed.feedid), '" rel="self" type="application/rss+xml" />\n\t\t\t',
  );
  for (const item of items) {
    const itemSiteConfig = itemSite(item, opts);
    const origin = `${site.scheme}://${itemSiteConfig.domain}${config.serverPort}`;
    const description = rssItemDescription(item.summary ?? '', item.body ?? '', {
      allowHtml: feed.allowhtml,
      version: 'RSS 2.0',
      origin,
    });
    const content = opts.renderContent ? addCompletePath(javaTrim(item.body ?? ''), origin) : '';
    const link = cfXmlFormat(contentUrl(itemSiteConfig, { filename: item.filename }, { complete: true }));
    out
      .whitespace()
      .text(
        '\n\t\t\t\t<item>\n',
        '\t\t\t\t\t<title>', cfXmlFormat(item.menutitle ?? ''), '</title>\n',
        // The commented-out <comments> element between </link> and <guid> leaves no output.
        '\t\t\t\t\t<link>', link, '</link><guid isPermaLink="false">', item.contentid ?? '', '</guid>\n',
        '\t\t\t\t\t<pubDate>', getHttpTimeString(itemPubDate(item)), '</pubDate>\n',
        '\t\t\t\t\t<description>', cfXmlFormat(description), '</description>\n\t\t\t\t\t',
      );
    for (const name of item.categories) out.text('<category>', cfXmlFormat(name), '</category>');
    out.whitespace();
    if (content !== '') out.text('<content:encoded><![CDATA[', content, ']]></content:encoded>');
    out.whitespace();
    if (item.fileid) out.text(enclosure(fileRenderUrl(itemSiteConfig.scheme, itemSiteConfig, config, item), item.file));
    out.text('\n\t\t\t\t</item>\n\t\t');
  }
  return out.text('</channel>\n\t\t</rss>').whitespace().toString();
}

/** rss092 (feedApiUtility.cfc:386-446). */
export function writeRss092(feed: RssFeedView, items: readonly RssItemView[], opts: Rss092Options): string {
  const { site, config } = opts;
  const origin = `${site.scheme}://${site.domain}${config.serverPort}`;
  const out = new SaveContent().text(
    '<?xml version="1.0" ?>\n',
    '\t\t<rss version="0.92"\n',
    '\t\t\txmlns:dc="http://purl.org/dc/elements/1.1/">\n',
    '\t\t\t<channel>\n',
    '\t\t\t\t<title>', cfXmlFormat(renderName(feed)), '</title>\n',
    '\t\t\t\t<link>http://', opts.requestHost, '</link>\n',
    '\t\t\t\t<description>', cfXmlFormat(feed.description ?? ''), '</description>\n',
    '\t\t\t\t<webMaster>', opts.contact, '</webMaster>\n',
    '\t\t\t\t<language>', feed.lang ?? '', '</language>\n\t\t\t',
  );
  for (const item of items) {
    const itemSiteConfig = itemSite(item, opts);
    const description = rssItemDescription(item.summary ?? '', item.body ?? '', {
      allowHtml: feed.allowhtml,
      version: 'RSS 0.920',
      origin,
    });
    const link = cfXmlFormat(contentUrl(itemSiteConfig, { filename: item.filename }, { complete: true }));
    out
      .whitespace()
      .text(
        '\n\t\t\t\t\t<item>\n',
        '\t\t\t\t\t\t<title>', cfXmlFormat(item.menutitle ?? ''), '</title>\n',
        '\t\t\t\t\t\t<description><![CDATA[', description, ' ]]></description>\n',
        '\t\t\t\t\t\t<link>', link, '</link>\n',
        '\t\t\t\t\t\t<guid isPermaLink="true">', link, '</guid>\n',
        '\t\t\t\t\t\t<dc:date>', getHttpTimeString(itemPubDate(item)), '</dc:date>\n\t\t\t\t\t\t',
      );
    if (cfEq(item.type ?? '', 'File')) out.text(enclosure(fileRenderUrl('http', itemSiteConfig, config, item), item.file));
    out.text('\n\t\t\t\t\t</item>\n\t\t\t');
  }
  return out.text('\n\t\t\t</channel>\n\t\t</rss>').whitespace().toString();
}

/** The 200 response of a feed past setLocale: RSS by its case-insensitive version, else an empty page (feedApiUtility.cfc:267-275). */
export function renderFeed(feed: RssFeedView, items: readonly RssItemView[], opts: RenderFeedOptions): FeedResponse {
  const version = (feed.version ?? '').toLowerCase();
  let body: string | null = null;
  if (version === 'rss 2.0') body = writeRss20(feed, items, opts);
  else if (version === 'rss 0.920') body = writeRss092(feed, items, opts);
  return {
    status: 200,
    contentType: body === null ? UNRENDERED_CONTENT_TYPE : RSS_CONTENT_TYPE,
    contentLanguage: opts.javaLocale.replaceAll('_', '-'),
    body: body ?? '',
  };
}
