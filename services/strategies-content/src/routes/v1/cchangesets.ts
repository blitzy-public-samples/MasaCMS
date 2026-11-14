/** cchangesets admin routes: change-set list, edit, assignments and actions. */
import { LegacyServiceUnavailableError, cfDateTimeFormat, cfNumberString } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
// The edit and list views print the category tree and the assignments view each row's crumbs, which only these read.
import { countCategories, listCategories } from '../../domain/categories.js';
import {
  assignments,
  changesetTagCloud,
  deleteChangeset,
  listChangesets,
  pendingApprovalCount,
  readChangeset,
  removeItem,
  rollback,
  saveChangeset,
  type ChangesetAssignments,
  type ChangesetBean,
} from '../../domain/changesets.js';
import { getCrumbList } from '../../domain/content-tree.js';
import type { Actor } from '../../domain/context.js';
import { getCategoryPerm, getNodePerm, loadMemberships, sitePools, type SitePools, type UserMemberships } from '../../domain/permissions.js';
import type { components } from '../../generated/openapi.js';
import { iconClass } from '../../legacy/admin-markup.js';
import { renderTagArray, type AdminRenderResult } from '../../legacy/admin-render.js';
import type { ContentRouteContext } from '../index.js';
import { adminCsrf, adminRedirect, circuitRouteConfig, csrfRejected, requireCircuitAccess, type AdminWriteResult } from './access.js';

/** The contract's screen model: values under their legacy `rc` names. */
type AdminViewModel = components['schemas']['AdminViewModel'];

/** FW/1's request context; keys match ignoring case, as CFML resolves them. */
type Rc = Record<string, unknown>;

type SiteParams = { siteid: string };
type ChangesetParams = SiteParams & { changesetid: string };
type ItemParams = ChangesetParams & { contenthistid: string };

/** One assigned version as the assignments iterator returns it. */
type AssignmentRow = ChangesetAssignments['component'][number];

const CIRCUIT = 'cchangesets';
const LIST_PATH = '/v1/sites/:siteid/changesets';
const CHANGESET_PATH = '/v1/sites/:siteid/changesets/:changesetid';
const DELETE_PATH = `${CHANGESET_PATH}/delete`;
const ROLLBACK_PATH = `${CHANGESET_PATH}/rollback`;
const ASSIGNMENTS_PATH = `${CHANGESET_PATH}/assignments`;
const REMOVE_ITEM_PATH = `${CHANGESET_PATH}/items/:contenthistid/remove`;

/** cChangesets.before()'s `param` defaults (cchangesets.cfc:86-92), in declaration order. */
const RC_DEFAULTS: ReadonlyArray<readonly [string, unknown]> = [
  ['startrow', 1],
  ['startdate', ''],
  ['stopdate', ''],
  ['page', 1],
  ['keywords', ''],
  ['categoryid', ''],
  ['tags', ''],
];

/** LegacyServiceUnavailableError reason of every value these views or writes need from tsettings and configBean. */
export const CHANGESET_SITE_SETTINGS_REASON = 'changeset-site-settings';

// Custom icon classes apply only to page, folder, calendar, gallery, file, link and portal crumbs (extendManager.cfc:154-180).
// The component, form and variation rows these crumbs are built for, and their module roots, are none of those.
const NO_CUSTOM_ICONS = (): string => '';

/** `rc[key]` ignoring key case; undefined when absent. */
function rcValue(rc: Rc, key: string): unknown {
  const wanted = key.toLowerCase();
  const name = Object.keys(rc).find((candidate) => candidate.toLowerCase() === wanted);
  return name === undefined ? undefined : rc[name];
}

/** `rc[key] = value`, replacing the key in any case, as a CFML struct assignment does. */
function setRc(rc: Rc, key: string, value: unknown): void {
  const wanted = key.toLowerCase();
  for (const name of Object.keys(rc)) {
    if (name.toLowerCase() === wanted) delete rc[name];
  }
  rc[key] = value;
}

/** `rc[key]` as CFML text; undefined when absent. */
function rcText(rc: Rc, key: string): string | undefined {
  const value = rcValue(rc, key);
  if (value === undefined || typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  throw new TypeError(`Complex object types cannot be converted to simple values: RC.${key.toUpperCase()}`);
}

/** `arguments.rc[key]`, which the controller reads unguarded. */
function requiredRcText(rc: Rc, key: string): string {
  const value = rcText(rc, key);
  if (value === undefined) throw new Error(`Element ${key.toUpperCase()} is undefined in ARGUMENTS.RC.`);
  return value;
}

/** The action's `rc`: url and form fields, the route's path values over them, then before()'s defaults where still absent. */
function requestRc(request: FastifyRequest, path: Readonly<Record<string, string>>): Rc {
  const rc: Rc = { ...legacyParamsOf(request) };
  for (const [key, value] of Object.entries(path)) setRc(rc, key, value);
  for (const [key, value] of RC_DEFAULTS) {
    if (rcValue(rc, key) === undefined) rc[key] = value;
  }
  return rc;
}

/** The legacy 503 for a branch that prints or saves site settings no verified source of this service holds. */
function siteSettingsUnavailable(message: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(message, 'auto', CHANGESET_SITE_SETTINGS_REASON);
}

/** `rc.$.validateCSRFTokens(context=rc.changesetid)` after the circuit gate: identity consumes the token; false when refused. */
async function changesetTokenValid(request: FastifyRequest, reply: FastifyReply, changesetId: string): Promise<boolean> {
  await adminCsrf(() => changesetId).call(request.server, request, reply);
  return !csrfRejected(request);
}

/** A date as the contract's LocalTimestamp text; an unset date as the '' a bean holds. */
function localTimestamp(value: Date | null): string {
  return value === null ? '' : cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss.lll').replace(' ', 'T');
}

/** changesetBean.getAllValues() under its property names. */
function beanValues(bean: ChangesetBean): Rc {
  return {
    changesetID: bean.changesetid,
    siteID: bean.siteid,
    name: bean.name,
    description: bean.description,
    created: localTimestamp(bean.created),
    publishDate: localTimestamp(bean.publishdate),
    published: bean.published,
    lastUpdate: localTimestamp(bean.lastupdate),
    lastUpdateBy: bean.lastupdateby,
    lastUpdateByID: bean.lastupdatebyid,
    remoteID: bean.remoteid,
    remoteSourceURL: bean.remotesourceurl,
    remotePubDate: localTimestamp(bean.remotepubdate),
    closeDate: localTimestamp(bean.closedate),
    categoryID: bean.categoryid,
    tags: bean.tags,
    isNew: bean.isnew,
    errors: bean.errors,
  };
}

/** A query row keyed by column, its dates as LocalTimestamp text. */
function rowValues(row: object): Rc {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? localTimestamp(value) : value]));
}

/** One `cf_dsp_categories_nest` category: what its checkbox prints, then its children. */
interface CategoryNode {
  categoryID: string;
  parentID: string;
  name: string;
  /** `rslist.isOpen eq 1`: only an open category prints a checkbox. */
  isOpen: boolean;
  /** `getCategoryPerm(rslist.restrictGroups, siteid)`; a refused category prints its checkbox disabled. */
  permitted: boolean;
  children: CategoryNode[];
}

/** `getCategoryCount(siteid)` and, when non-zero, `cf_dsp_categories_nest parentID=""` (dsp_categories_nest.cfm), level by level. */
async function categoryTree(ctx: ContentRouteContext, actor: Actor, siteId: string): Promise<{ count: number; nodes: CategoryNode[] }> {
  const deps = ctx.domain;
  const count = await countCategories(deps, actor);
  if (count === 0) return { count, nodes: [] };
  let viewer: Promise<[UserMemberships, SitePools]> | undefined;
  const permitted = async (restrictGroups: string): Promise<boolean> => {
    viewer ??= Promise.all([loadMemberships(deps, actor), sitePools(deps, actor)]);
    const [memberships, pools] = await viewer;
    return getCategoryPerm(actor, memberships, restrictGroups, siteId, pools);
  };
  const level = async (parentId?: string): Promise<CategoryNode[]> => {
    const nodes: CategoryNode[] = [];
    for (const row of await listCategories(deps, actor, parentId === undefined ? {} : { parentId })) {
      nodes.push({
        categoryID: row.categoryid,
        parentID: row.parentid ?? '',
        name: row.name ?? '',
        isOpen: row.isopen === 1,
        permitted: await permitted(row.restrictgroups ?? ''),
        children: row.haskids > 0 ? await level(row.categoryid) : [],
      });
    }
    return nodes;
  };
  return { count, nodes: await level() };
}

/** The tree's categories as rows, each parent before its children. */
function categoryRows(nodes: readonly CategoryNode[]): Rc[] {
  return nodes.flatMap(({ children, ...row }) => [row, ...categoryRows(children)]);
}

/** cChangesets.list (cchangesets.cfc:95-139): the page of change sets with the feed iterator's paging, and the category tree. */
async function listModel(ctx: ContentRouteContext, actor: Actor, rc: Rc): Promise<AdminViewModel> {
  const page = await listChangesets(ctx.domain, actor, rc);
  // list.cfm previews an unpublished change set at the home page's complete URL.
  if (page.changesets.some((bean) => !bean.published)) {
    throw siteSettingsUnavailable('cChangesets.list prints preview URLs built from site settings this service does not hold');
  }
  const { recordCount, nextN, pageIndex } = page;
  const first = (pageIndex - 1) * nextN;
  const categories = await categoryTree(ctx, actor, requiredRcText(rc, 'siteid'));
  return {
    rc: {
      changesets: {
        pageIndex,
        pageCount: Math.ceil(recordCount / nextN),
        recordCount,
        firstRecordOnPageIndex: first > recordCount ? 1 : first + 1,
        lastRecordOnPageIndex: Math.min(first + nextN, recordCount),
        items: page.changesets.map(beanValues),
      },
      categoryCount: categories.count,
      categories: categories.nodes,
    },
  };
}

/** What edit.cfm reads besides the menu: the bean, `hasPendingApprovals()` of an unpublished one, and the category rows. */
async function editModel(ctx: ContentRouteContext, actor: Actor, bean: ChangesetBean, siteId: string): Promise<Rc> {
  const pending = bean.published ? undefined : await pendingApprovalCount(ctx.domain, actor, bean.changesetid);
  const categories = await categoryTree(ctx, actor, siteId);
  return {
    changeset: beanValues(bean),
    ...(pending === undefined ? {} : { hasPendingApprovals: pending }),
    categoryCount: categories.count,
    categories: categoryRows(categories.nodes),
  };
}

/** An assigned version with the `getCrumbList(contentid, rc.siteid, false, path)` crumbs and node verdict the view prints. */
async function assignmentRow(ctx: ContentRouteContext, actor: Actor, siteId: string, memberships: UserMemberships, row: AssignmentRow): Promise<Rc> {
  const crumbs = await getCrumbList(ctx.domain, actor, { contentId: row.contentid ?? '', siteId, ...(row.path === null ? {} : { path: row.path }) });
  return {
    ...rowValues(row),
    verdict: await getNodePerm(ctx.domain, actor, crumbs, memberships),
    crumbdata: crumbs.map((crumb) => ({ ...rowValues(crumb), icon: iconClass(NO_CUSTOM_ICONS, crumb) })),
  };
}

/** cChangesets.assignments (cchangesets.cfc:156-164): the change set and its assigned versions per module. */
async function assignmentsModel(ctx: ContentRouteContext, actor: Actor, rc: Rc): Promise<AdminViewModel> {
  const siteId = requiredRcText(rc, 'siteid');
  const found = await assignments(ctx.domain, actor, { changesetId: requiredRcText(rc, 'changesetid'), keywords: rcText(rc, 'keywords') });
  // The menu's change-set preview and every site architecture row's preview print complete content URLs.
  if (!found.changeset.published || found.site.length > 0) {
    throw siteSettingsUnavailable('cChangesets.assignments prints preview URLs built from site settings this service does not hold');
  }
  const memberships = await loadMemberships(ctx.domain, actor);
  const rows = async (list: readonly AssignmentRow[]): Promise<Rc[]> => {
    const out: Rc[] = [];
    for (const row of list) out.push(await assignmentRow(ctx, actor, siteId, memberships, row));
    return out;
  };
  return {
    rc: {
      changeset: beanValues(found.changeset),
      siteAssignments: [],
      componentAssignments: await rows(found.component),
      formAssignments: await rows(found.form),
      ...(found.variation === undefined ? {} : { variationAssignments: await rows(found.variation) }),
    },
  };
}

/** The contract outcome of an action that redirects whether or not it wrote. */
function redirected(saved: boolean, redirect: AdminWriteResult['redirect']): AdminWriteResult {
  return { saved, errors: {}, redirect };
}

/** Registers the cchangesets operations the contract lists; `cChangesets.publish` is withheld and stays on legacy. */
export async function registerChangesetRoutes(app: FastifyInstance, ctx: ContentRouteContext): Promise<void> {
  /** cChangesets.list: one page of the site's change sets narrowed by the filters. */
  app.get<{ Params: SiteParams; Reply: AdminViewModel }>(LIST_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    return listModel(ctx, actor, requestRc(request, request.params));
  });

  /** cChangesets.save: `read(rc.changesetID).set(rc).save()` once the token validates, then the list redirect or the edit view. */
  app.post<{ Params: SiteParams; Reply: AdminWriteResult }>(LIST_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const rc = requestRc(request, request.params);
    if (!(await changesetTokenValid(request, reply, requiredRcText(rc, 'changesetid')))) {
      // Legacy leaves `rc.changeset` undefined, and save.cfm's include of edit.cfm fails reading it.
      return { saved: false, errors: {}, redirect: null, data: { rc: {} } };
    }
    const result = await saveChangeset(ctx.domain, actor, rc);
    setRc(rc, 'changesetID', result.changeset.changesetid);
    if (result.redirect) {
      return { saved: true, errors: {}, redirect: adminRedirect('cChangesets.list', rc, ['changesetID', 'siteID']) };
    }
    // The menu prints nothing for the `save` action, so the re-rendered view needs no preview link.
    const model = await editModel(ctx, actor, result.changeset, request.params.siteid);
    return { saved: false, errors: result.errors, redirect: null, data: { rc: model } };
  });

  /** cChangesets.edit: `changesetManager.read(rc.changesetID)` and the edit view's data. */
  app.get<{ Params: ChangesetParams; Reply: AdminViewModel }>(CHANGESET_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const bean = await readChangeset(ctx.domain, actor, request.params.changesetid);
    // The menu previews a stored, unpublished change set at the site's complete web path.
    if (!bean.isnew && !bean.published) {
      throw siteSettingsUnavailable('cChangesets.edit prints a preview URL built from site settings this service does not hold');
    }
    return { rc: await editModel(ctx, actor, bean, request.params.siteid) };
  });

  /** cChangesets.delete: the change set is thrown in the trash and deleted once the token validates; always the list redirect. */
  app.post<{ Params: ChangesetParams; Reply: AdminWriteResult }>(DELETE_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const rc = requestRc(request, request.params);
    const changesetId = requiredRcText(rc, 'changesetid');
    const valid = await changesetTokenValid(request, reply, changesetId);
    if (valid) await deleteChangeset(ctx.domain, actor, changesetId);
    return redirected(valid, adminRedirect('cChangesets.list', rc, ['changesetID', 'siteID']));
  });

  /** cChangesets.rollback: changesetManager.rollback once the token validates; always the edit redirect. */
  app.post<{ Params: ChangesetParams; Reply: AdminWriteResult }>(ROLLBACK_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const rc = requestRc(request, request.params);
    const changesetId = requiredRcText(rc, 'changesetid');
    const valid = await changesetTokenValid(request, reply, changesetId);
    if (valid) {
      // Re-saving a published change set's versions reads site settings no verified source holds; the save then fails
      // closed inside its transaction and writes nothing, while an unpublished change set needs none.
      const site = (): never => {
        throw siteSettingsUnavailable('cChangesets.rollback re-saves content, which reads site settings this service does not hold');
      };
      await rollback({ ...ctx.domain, storage: ctx.storage }, actor, site, changesetId);
    }
    return redirected(valid, adminRedirect('cChangesets.edit', rc, ['changesetID', 'siteID']));
  });

  /** cChangesets.assignments: the assigned versions per module, narrowed by `rc.keywords`. */
  app.get<{ Params: ChangesetParams; Reply: AdminViewModel }>(ASSIGNMENTS_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    return assignmentsModel(ctx, actor, requestRc(request, request.params));
  });

  /** cChangesets.removeitem: detaches the version once the token validates; always the assignments redirect. */
  app.post<{ Params: ItemParams; Reply: AdminWriteResult }>(REMOVE_ITEM_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const rc = requestRc(request, request.params);
    const changesetId = requiredRcText(rc, 'changesetid');
    const valid = await changesetTokenValid(request, reply, changesetId);
    if (valid) await removeItem(ctx.domain, actor, changesetId, requiredRcText(rc, 'contenthistid'));
    return redirected(valid, adminRedirect('cChangesets.assignments', rc, ['changesetID', 'siteID', 'keywords']));
  });
}

/** The circuit's raw responses, registered by `./raw.ts`. */
export const cchangesetsRawActions = Object.freeze({
  loadtagarray: Object.freeze({
    /** cchangesets/loadtagarray.cfm: the change-set tag cloud as a JavaScript array literal. */
    run: async (_request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<AdminRenderResult> =>
      renderTagArray(await changesetTagCloud(ctx.domain, actor), 'cchangesets'),
  }),
});
