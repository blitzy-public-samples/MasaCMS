/** ccomments admin routes: comment moderation grid and actions (ccomments.cfc:86-360). */
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { listPoolCategories } from '../../domain/categories.js';
import {
  approveCommentAction,
  bulkEdit,
  deleteCommentAction,
  loadComments,
  loadCommentsPage,
  markAsSpamAction,
  purgeDeletedCommentsAction,
  singleEdit,
  unapproveCommentAction,
  type CommentCallOptions,
  type CommentEditResult,
  type CommentRedirectResult,
  type CommentSite,
} from '../../domain/comments.js';
import type { Actor, SiteContentSettings } from '../../domain/context.js';
import { registrySite } from '../../jobs/feed-auto-import.js';
import {
  createAdminLabels,
  renderCommentsAjax,
  renderLoadComments,
  renderLoadCommentsPage,
  type AdminRenderContext,
  type AdminRenderResult,
  type CommentsCategoryNode,
} from '../../legacy/admin-render.js';
import { contentUrl } from '../../legacy/content-urls.js';
import { requestScheme } from '../comments-proxy.js';
import type { ContentRouteContext } from '../index.js';
import { adminRedirect, circuitRouteConfig, requireCircuitAccess, type AdminWriteResult } from './access.js';

/** The contract's `AdminViewModel`: what the controller and view compute for the screen. */
interface CommentsViewModel {
  rc: Record<string, unknown>;
}

type SiteParams = { siteid: string };
type CommentParams = SiteParams & { commentid: string };

/** A redirecting comment action over the controller's `rc`. */
type CommentAction = (request: FastifyRequest, ctx: ContentRouteContext, actor: Actor, rc: Record<string, unknown>) => Promise<CommentRedirectResult>;

const SITE_COMMENTS_PATH = '/v1/sites/:siteid/comments';
const COMMENT_PATH = `${SITE_COMMENTS_PATH}/:commentid`;

// The contract declares no source of the admin session's locale, so the session values are those Masa sets on this
// en_US server under configBean's default locale `Server` (resourceBundleFactory.cfc:660-701, utils.cfc:328-379).
const SESSION_LOCALE = 'en_US';
const SESSION_DATE_KEY_FORMAT = 'MM/DD/YYYY';

/** settingsBean defaults (settingsBean.cfc:206, 243) of settings this service holds no projection of. */
const SITE_NEXT_N = 20;
const COMMENT_APPROVAL_DEFAULT = 1;

// The admin keys the comment views print, as core/mura/resourceBundle/resources/en.properties holds them (lines 282-306,
// 833, 877, 1612, 1742). comments.morecomments and comments.inreplyto are in no bundle and print `<key>_missing`.
const COMMENT_VIEW_LABELS = createAdminLabels({
  'comments.all': 'ALL',
  'comments.approve': 'Approve',
  'comments.delete': 'Delete',
  'comments.message.confirm.approve': 'Are you sure you want to approve the selected comments?',
  'comments.message.confirm.delete': 'Are you sure you want to delete the selected comments?',
  'comments.selectall': 'Select All',
  'comments.sortbydatetime': 'Sort By Date/Time',
  'comments.sortbyname': 'Sort By Name',
  'comments.unapprove': 'Unapprove',
  'params.from': 'From',
  'params.to': 'To',
  'sitemanager.search': 'Search',
  'user.email': 'Email',
});

/** The request's legacy params with `values` set over any spelling of their names, as the controller's `rc` holds them. */
function rcOf(request: FastifyRequest, values: Readonly<Record<string, string>>): Record<string, unknown> {
  const names = new Set(Object.keys(values).map((name) => name.toLowerCase()));
  const params = Object.entries(legacyParamsOf(request)).filter(([name]) => !names.has(name.toLowerCase()));
  return { ...Object.fromEntries(params), ...values };
}

/** How the admin actions call the comment manager; the errors it swallows are logged, legacy's outcome kept. */
function callOptions(request: FastifyRequest): CommentCallOptions {
  return {
    apiRequest: false,
    requestId: request.id,
    onSwallowedError: (error, operation) => {
      request.log.warn({ error }, `ccomments ${operation}: error swallowed as legacy swallows it`);
    },
  };
}

// This service holds no tsettings or configBean projection (programs-sites owns them) and the contract names no source,
// so the settings are the registry's as jobs/feed-auto-import.ts builds them, with the scheme settingsBean.getScheme reads
// from the request.
/** The token site's settings the comment views and saves read. */
async function siteSettingsOf(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<SiteContentSettings> {
  const settings = await registrySite(ctx.domain.db, actor.tenantId, actor.siteId);
  return { ...settings, urls: { ...settings.urls, scheme: requestScheme(request) } };
}

// The site name and contact address are read only by the subscriber notices, which these routes never send.
/** The comment bean's site: its URLs, the approval default and content links built by the site's renderer. */
function commentSite(settings: SiteContentSettings): CommentSite {
  const { siteId, site, contactEmail, urls } = settings;
  return {
    siteId,
    site,
    contactEmail,
    urls,
    commentApprovalDefault: settings.commentApprovalDefault ?? COMMENT_APPROVAL_DEFAULT,
    contentUrl: (content, querystring) => contentUrl(urls, content ?? { filename: null }, { querystring, complete: true }),
  };
}

/** The comment site of the token's site. */
async function commentSiteFor(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<CommentSite> {
  return commentSite(await siteSettingsOf(request, ctx, actor));
}

// The comment views read only the labels, the site's URL settings and session.locale; the session and site values they
// never read keep legacy's initial ones.
/** The render context of the comment views for `actor`. */
function viewContext(actor: Actor, settings: SiteContentSettings): AdminRenderContext {
  return {
    labels: COMMENT_VIEW_LABELS,
    session: {
      userId: actor.userId,
      siteId: actor.siteId,
      memberships: '',
      nextN: SITE_NEXT_N,
      dateKeyFormat: SESSION_DATE_KEY_FORMAT,
      rb: SESSION_LOCALE,
      locale: SESSION_LOCALE,
      openSectionList: '',
      flatViewArgs: {},
      copyContentId: '',
      copySiteId: '',
      copyAll: false,
    },
    site: settings.urls,
    siteSettings: {
      locking: settings.locking,
      hasComments: true,
      hasLockableNodes: false,
      privateUserPoolId: actor.siteId,
      extranet: false,
    },
    config: { sortPermission: '', adminDir: '/admin', context: '' },
    csrf: () => {
      throw new Error('The ccomments views render no CSRF token');
    },
  };
}

type PoolCategory = Awaited<ReturnType<typeof listPoolCategories>>[number];

/** A category id as SQL Server's case-insensitive `char` comparison matches it. */
function idKey(id: string): string {
  return id.trimEnd().toLowerCase();
}

/**
 * The tree dspCategoriesNestSelect walks (contentCommentManager.cfc:350-388): each level is what getCategories returns for
 * its parent, by name, built from one read of the token site's category pool.
 */
async function categoryTree(ctx: ContentRouteContext, actor: Actor): Promise<CommentsCategoryNode[]> {
  const byParent = new Map<string | null, PoolCategory[]>();
  for (const row of await listPoolCategories(ctx.domain, actor)) {
    const key = row.parentid === null ? null : idKey(row.parentid);
    const level = byParent.get(key);
    if (level === undefined) byParent.set(key, [row]);
    else level.push(row);
  }
  const level = (parentKey: string | null): CommentsCategoryNode[] =>
    (byParent.get(parentKey) ?? []).map((row) => ({
      categoryid: row.categoryid,
      name: row.name,
      isopen: row.isopen,
      children: level(idKey(row.categoryid)),
    }));
  return level(null);
}

/** ccomments.loadComments (ccomments.cfc:204-282) rendered by loadcomments.cfm in the session site, the token's. */
async function loadCommentsFragment(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<AdminRenderResult> {
  const session = { sessionSiteId: actor.siteId, dateKeyFormat: SESSION_DATE_KEY_FORMAT, javaLocale: SESSION_LOCALE };
  const page = await loadComments(ctx.domain, actor, legacyParamsOf(request), session);
  const categories = await categoryTree(ctx, actor);
  const settings = await siteSettingsOf(request, ctx, actor);
  return renderLoadComments({ ...page, categories }, viewContext(actor, settings));
}

// isEditor (ccomments.cfc:292-295) is not computed: loadcommentspage.cfm never prints it, and the circuit gate already
// implies the comments module permission it ends in.
/** ccomments.loadCommentsPage (ccomments.cfc:284-352) rendered by loadcommentspage.cfm in the event site, the token's. */
async function loadCommentsPageFragment(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<AdminRenderResult> {
  const page = await loadCommentsPage(ctx.domain, actor, legacyParamsOf(request), actor.siteId);
  const settings = await siteSettingsOf(request, ctx, actor);
  // A commenter's user photo (tusers.photoFileID) is people's data, out of this service's reach, so avatars are Gravatars.
  const rows = page.rows.map((row) => ({ ...row, remoteUser: null }));
  const model = { commentId: page.commentId, upperId: page.upperId, lowerId: page.lowerId, rows, now: page.now };
  return renderLoadCommentsPage(model, viewContext(actor, settings));
}

/**
 * The raw ccomments responses, keyed by their `/v1/raw/ccomments/<action>` segment. None validates a CSRF token, as
 * legacy validates none in this circuit.
 */
export const ccommentsRawActions = Object.freeze({
  /** ccomments.ajax: ajax.cfm resets the output buffer and leaves an empty body. */
  ajax: { run: (): Promise<AdminRenderResult> => Promise.resolve(renderCommentsAjax()) },
  loadcomments: { run: loadCommentsFragment },
  loadcommentspage: { run: loadCommentsPageFragment },
});

/** An ajax edit's outcome: no redirect, as the view renders either way; `processed` stays unset where legacy leaves it. */
function editResult(result: CommentEditResult): AdminWriteResult {
  return {
    saved: result.processed !== false,
    errors: {},
    redirect: null,
    ...(result.processed === undefined ? {} : { data: { processed: result.processed } }),
  };
}

// FW/1's preserve of `processed,isapproved,siteid` and the `./` path are web's: the contract's redirect carries neither.
/** `redirect(action='cComments.default', …)` after a moderation action, `processed` as the manager answered. */
function managerRedirect(result: CommentRedirectResult, rc: Readonly<Record<string, unknown>>): AdminWriteResult {
  return { saved: result.processed, errors: {}, redirect: adminRedirect('cComments.default', rc, []) };
}

// The subscriber notices approve returns are dropped: this service sends no mail.
/** The redirecting actions on one comment, by their path suffix. */
const COMMENT_ACTIONS: ReadonlyArray<readonly [suffix: string, action: CommentAction]> = [
  [
    'approve',
    async (request, ctx, actor, rc) => approveCommentAction(ctx.domain, actor, rc, await commentSiteFor(request, ctx, actor), callOptions(request)),
  ],
  [
    'unapprove',
    async (request, ctx, actor, rc) => unapproveCommentAction(ctx.domain, actor, rc, await commentSiteFor(request, ctx, actor), callOptions(request)),
  ],
  ['delete', (request, ctx, actor, rc) => deleteCommentAction(ctx.domain, actor, rc, callOptions(request))],
  ['spam', (request, ctx, actor, rc) => markAsSpamAction(ctx.domain, actor, rc, callOptions(request))],
];

/** ccomments admin routes: comment moderation grid and actions. */
export function registerCommentAdminRoutes(app: FastifyInstance, ctx: ContentRouteContext): Promise<void> {
  /** ccomments.default (ccomments.cfc:104-105): the controller computes nothing beyond the gate and `rc.siteid`. */
  app.get<{ Params: SiteParams; Reply: CommentsViewModel }>(
    SITE_COMMENTS_PATH,
    { config: circuitRouteConfig('ccomments') },
    async (request) => {
      const { siteid } = request.params;
      await requireCircuitAccess(request, ctx, 'ccomments', siteid);
      return { rc: { siteid } };
    },
  );

  /** ccomments.bulkEdit (ccomments.cfc:107-139): one `bulkedit` action on every id of `ckupdate`. */
  app.post<{ Params: SiteParams; Reply: AdminWriteResult }>(
    `${SITE_COMMENTS_PATH}/bulk`,
    { config: circuitRouteConfig('ccomments') },
    async (request) => {
      const { siteid } = request.params;
      const actor = await requireCircuitAccess(request, ctx, 'ccomments', siteid);
      const site = await commentSiteFor(request, ctx, actor);
      return editResult(await bulkEdit(ctx.domain, actor, rcOf(request, { siteid }), site, callOptions(request)));
    },
  );

  /** ccomments.purgeDeletedComments (ccomments.cfc:354-357): removes the site's deleted comments. */
  app.post<{ Params: SiteParams; Reply: AdminWriteResult }>(
    `${SITE_COMMENTS_PATH}/purge-deleted`,
    { config: circuitRouteConfig('ccomments') },
    async (request) => {
      const { siteid } = request.params;
      const actor = await requireCircuitAccess(request, ctx, 'ccomments', siteid);
      const rc = rcOf(request, { siteid });
      return managerRedirect(await purgeDeletedCommentsAction(ctx.domain, actor, rc, callOptions(request)), rc);
    },
  );

  /** ccomments.singleEdit (ccomments.cfc:141-168): one `updateAction` on the comment. */
  app.post<{ Params: CommentParams; Reply: AdminWriteResult }>(
    COMMENT_PATH,
    { config: circuitRouteConfig('ccomments') },
    async (request) => {
      const { siteid, commentid } = request.params;
      const actor = await requireCircuitAccess(request, ctx, 'ccomments', siteid);
      const site = await commentSiteFor(request, ctx, actor);
      return editResult(await singleEdit(ctx.domain, actor, rcOf(request, { siteid, commentid }), site, callOptions(request)));
    },
  );

  /** ccomments.approve, unapprove, delete and markAsSpam (ccomments.cfc:170-202). */
  for (const [suffix, action] of COMMENT_ACTIONS) {
    app.post<{ Params: CommentParams; Reply: AdminWriteResult }>(
      `${COMMENT_PATH}/${suffix}`,
      { config: circuitRouteConfig('ccomments') },
      async (request) => {
        const { siteid, commentid } = request.params;
        const actor = await requireCircuitAccess(request, ctx, 'ccomments', siteid);
        const rc = rcOf(request, { siteid, commentid });
        return managerRedirect(await action(request, ctx, actor, rc), rc);
      },
    );
  }
  return Promise.resolve();
}
