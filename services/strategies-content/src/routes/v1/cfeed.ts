/** cfeed admin routes: collection list, edit and remote-feed import, and the loadsite, siteparents and update raw actions (cfeed.cfc). */
import { LegacyServiceUnavailableError, adminUrl, cfEq } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import type { Actor } from '../../domain/context.js';
import {
  FeedElementUndefinedError,
  FeedParamsQuery,
  defaultFetchRemote,
  listFeeds,
  previewFeedImport,
  updateFeedAction,
  type FeedBean,
  type FetchRemote,
} from '../../domain/feeds.js';
import { ADMIN_VIEW_CONTENT_TYPE, type AdminRenderResult } from '../../legacy/admin-render.js';
import type { components } from '../../generated/openapi.js';
import type { ContentRouteContext } from '../index.js';
import { adminRedirect, circuitRouteConfig, csrfRejected, requireCircuitAccess } from './access.js';

/** The route context these routes read; `fetchRemote` replaces the domain's single, unretried GET of a remote feed. */
export interface FeedAdminRouteContext extends ContentRouteContext {
  fetchRemote?: FetchRemote;
}

/** The contract's screen model: values under their legacy `rc` names. */
type AdminView = components['schemas']['AdminViewModel'];

type SiteRoute = { Params: { siteid: string } };
type FeedRoute = { Params: { siteid: string; feedid: string } };
type Rc = Readonly<Record<string, unknown>>;

/** A raw action as `./raw.ts` consumes it. */
interface FeedRawAction {
  run(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<AdminRenderResult>;
  csrfContext?: (request: FastifyRequest) => string;
}

// edit.cfm reads the site content renderer's `useLayoutManager()` and `defaultCollectionDisplayList`, which only the CFML
// runtime holds, and the site's custom image sizes and content-pool site names, which programs-sites owns and no event
// this service consumes carries; a model without them would render a different form, so the read fails closed.
const EDIT_UNAVAILABLE = 'The collection edit model needs site values this service does not hold';
const EDIT_UNAVAILABLE_REASON = 'feed-edit-site-values';

// The fragments print resource-bundle labels, and loadsite also the content-pool site names; neither has a source here.
const FRAGMENT_UNAVAILABLE = 'The collection search fragments print labels and site names this service does not hold';
const FRAGMENT_UNAVAILABLE_REASON = 'feed-fragment-labels';

// update.cfm's close document prints the layout-manager flag, the home page URL and the session's front-end proxy
// location, and its error branch includes edit.cfm; none of these has a source here, so the save is refused unwritten.
const COMPACT_UNAVAILABLE = 'A compact-display collection save renders values this service does not hold';
const COMPACT_UNAVAILABLE_REASON = 'feed-compact-display';

/** `rc[key]` matched ignoring case, as CFML text; undefined when the request lacks it. */
function rcText(rc: Rc, key: string): string | undefined {
  const lower = key.toLowerCase();
  const name = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  const value = name === undefined ? undefined : rc[name];
  return value === undefined || value === null ? undefined : String(value);
}

/** `arguments.rc.feedid`, which update dereferences before validating the token (cfeed.cfc:118). */
function feedIdOf(rc: Rc): string {
  const feedId = rcText(rc, 'feedid');
  if (feedId === undefined) throw new FeedElementUndefinedError('feedid', 'ARGUMENTS.RC');
  return feedId;
}

/** A feed bean as its `getAllValues()` struct, the params query as its rows. */
function beanValues(bean: FeedBean): Record<string, unknown> {
  return Object.fromEntries(bean.entries().map(([key, value]) => [key, value instanceof FeedParamsQuery ? value.rows : value]));
}

/** FW/1 `redirect(action="cFeed.list", append="siteid", path="./")`, the cflocation every finished update sends. */
function listRedirect(rc: Rc): AdminRenderResult {
  const { circuit, action, params } = adminRedirect('cFeed.list', rc, ['siteid']);
  return { status: 302, contentType: ADMIN_VIEW_CONTENT_TYPE, body: '', redirect: adminUrl({ circuit, action, params, adminDir: '.' }) };
}

/** cfeed.update (cfeed.cfc:117-146): add, update or delete for a valid token, then the redirect to cFeed.list. */
async function runUpdate(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<AdminRenderResult> {
  const rc = legacyParamsOf(request);
  feedIdOf(rc);
  if (csrfRejected(request)) return listRedirect(rc);
  // The token, when valid, is already consumed, as legacy consumes it; the refusal writes nothing.
  if (cfEq(rcText(rc, 'closeCompactDisplay') ?? '', 'true')) {
    throw new LegacyServiceUnavailableError(COMPACT_UNAVAILABLE, 'auto', COMPACT_UNAVAILABLE_REASON);
  }
  const outcome = await updateFeedAction(ctx.domain, actor, rc, { csrfValid: true, requestId: request.id });
  if (outcome.kind === 'redirect') return listRedirect(rc);
  // Outside compact display only a save that failed validation re-renders, and that save wrote nothing.
  throw new LegacyServiceUnavailableError(EDIT_UNAVAILABLE, 'auto', EDIT_UNAVAILABLE_REASON);
}

/** The fragment actions, which fail closed before any read. */
async function runFragment(): Promise<AdminRenderResult> {
  throw new LegacyServiceUnavailableError(FRAGMENT_UNAVAILABLE, 'auto', FRAGMENT_UNAVAILABLE_REASON);
}

/** The cfeed actions served under `/v1/raw/cfeed/<action>`. */
export const cfeedRawActions = {
  loadsite: { run: runFragment },
  siteparents: { run: runFragment },
  update: {
    run: runUpdate,
    csrfContext: (request: FastifyRequest): string => feedIdOf(legacyParamsOf(request)),
  },
} satisfies Readonly<Record<string, FeedRawAction>>;

/** cfeed.list (cfeed.cfc:106-109): the site's Local and Remote collections. */
async function listView(request: FastifyRequest<SiteRoute>, ctx: FeedAdminRouteContext): Promise<AdminView> {
  const actor = await requireCircuitAccess(request, ctx, 'cfeed', request.params.siteid);
  const { rsLocal, rsRemote } = await listFeeds(ctx.domain, actor, request.params.siteid);
  return { rc: { rsLocal, rsRemote } };
}

/** cfeed.edit (cfeed.cfc:111-115): refused after the gate, as its model needs site values this service does not hold. */
async function editView(request: FastifyRequest<FeedRoute>, ctx: FeedAdminRouteContext): Promise<AdminView> {
  await requireCircuitAccess(request, ctx, 'cfeed', request.params.siteid);
  throw new LegacyServiceUnavailableError(EDIT_UNAVAILABLE, 'auto', EDIT_UNAVAILABLE_REASON);
}

/** cfeed.import1: the feed and the remote items an import would bring in. */
async function importView(request: FastifyRequest<FeedRoute>, ctx: FeedAdminRouteContext): Promise<AdminView> {
  const actor = await requireCircuitAccess(request, ctx, 'cfeed', request.params.siteid);
  const { siteid, feedid } = request.params;
  const preview = await previewFeedImport(ctx.domain, actor, { feedId: feedid, siteId: siteid }, ctx.fetchRemote ?? defaultFetchRemote);
  return { rc: { feedBean: beanValues(preview.feedBean), items: preview.items } };
}

/** Registers `listFeeds`, `getFeed` and `previewFeedImport`; cfeed.import2 is withheld and stays on legacy. */
export async function registerFeedAdminRoutes(app: FastifyInstance, ctx: FeedAdminRouteContext): Promise<void> {
  app.get<SiteRoute>('/v1/sites/:siteid/feeds', { config: circuitRouteConfig('cfeed') }, (request) => listView(request, ctx));
  app.get<FeedRoute>('/v1/sites/:siteid/feeds/:feedid', { config: circuitRouteConfig('cfeed') }, (request) => editView(request, ctx));
  app.get<FeedRoute>('/v1/sites/:siteid/feeds/:feedid/import', { config: circuitRouteConfig('cfeed') }, (request) => importView(request, ctx));
}
