/** cchangesets admin routes: change-set list, edit, assignments and actions. */
import type { Readable } from 'node:stream';
import { LegacyApiError, LegacyFaultError, LegacyServiceUnavailableError, cfDateTimeFormat, cfNumberString } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
// The edit and list views print the category tree and the assignments view each row's crumbs, which only these read.
import { countCategories, readCategoryWalkBatches } from '../../domain/categories.js';
import {
  changesetTagCloud,
  deleteChangeset,
  listChangesets,
  pendingApprovalCount,
  readAssignmentBatches,
  readChangeset,
  removeItem,
  rollback,
  saveChangeset,
  type AssignmentList,
  type ChangesetBean,
} from '../../domain/changesets.js';
import { getCrumbListsInTx } from '../../domain/content-tree.js';
import type { Actor } from '../../domain/context.js';
import { getCategoryPerm, getNodePermsInTx, loadMemberships, sitePools, type UserMemberships } from '../../domain/permissions.js';
import type { components } from '../../generated/openapi.js';
import { iconClass } from '../../legacy/admin-markup.js';
import { renderTagArray, type AdminRenderResult } from '../../legacy/admin-render.js';
import type { CategoryWalkRow, ChangesetAssignmentRow } from '../../repo/repository.js';
import type { ContentRouteContext } from '../index.js';
import { adminCsrf, adminRedirect, circuitRouteConfig, csrfRejected, requireCircuitAccess, type AdminWriteResult } from './access.js';
import { VIEW_MODEL_CONTENT_TYPE, nestedJson, settled, streamModel } from './streamed-model.js';

/** The contract's screen model: values under their legacy `rc` names. */
type AdminViewModel = components['schemas']['AdminViewModel'];

/** FW/1's request context; keys match ignoring case, as CFML resolves them. */
type Rc = Record<string, unknown>;

type SiteParams = { siteid: string };
type ChangesetParams = SiteParams & { changesetid: string };
type ItemParams = ChangesetParams & { contenthistid: string };

/** One assigned version as the assignments iterator returns it. */
type AssignmentRow = ChangesetAssignmentRow;

/** The rc key each module list of the assignments view prints under. */
const ASSIGNMENT_KEYS = {
  component: 'componentAssignments',
  form: 'formAssignments',
  variation: 'variationAssignments',
} as const satisfies Record<AssignmentList, string>;

type AssignmentKey = (typeof ASSIGNMENT_KEYS)[AssignmentList];

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

/** The `server_error` naming the Expression fault `message`, which web answers with onError's page. */
function legacyFault(message: string): LegacyApiError {
  return new LegacyApiError('server_error', { stacktrace: new LegacyFaultError(message).trace() });
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

/** A walked category's checkbox, without its children. */
type CategoryCheckbox = Omit<CategoryNode, 'children'>;

/** `getCategoryCount(siteid)` and, when non-zero, each walked category's checkbox, its memberships and pools read before the walk's cursor opens. */
async function categoryCheckboxes(ctx: ContentRouteContext, actor: Actor, siteId: string): Promise<{ count: number; checkboxOf?: (row: CategoryWalkRow) => CategoryCheckbox }> {
  const deps = ctx.domain;
  const count = await countCategories(deps, actor);
  if (count === 0) return { count };
  const [memberships, pools] = await Promise.all([loadMemberships(deps, actor), sitePools(deps, actor)]);
  return {
    count,
    checkboxOf: (row) => ({
      categoryID: row.categoryid,
      parentID: row.parentid ?? '',
      name: row.name ?? '',
      isOpen: row.isopen === 1,
      permitted: getCategoryPerm(actor, memberships, row.restrictgroups ?? '', siteId, pools),
    }),
  };
}

/**
 * The model `build` sets from the category count, its `categories` slot printing `cf_dsp_categories_nest parentID=""` batch by batch, nested or, when `flat`, as rows.
 * @throws Error Before any byte, when a category is its own ancestor, where the legacy walk would never end.
 */
function categoryTreeBody(
  ctx: ContentRouteContext,
  actor: Actor,
  siteId: string,
  flat: boolean,
  build: (count: number, categories: string) => AdminViewModel | AdminWriteResult,
): Promise<Readable> {
  return streamModel(['categories'], async (out) => {
    const { count, checkboxOf } = await categoryCheckboxes(ctx, actor, siteId);
    out.head((slot) => build(count, slot.categories));
    if (checkboxOf === undefined) return;
    const nest = nestedJson('children');
    await readCategoryWalkBatches(ctx.domain, actor, 'withKids', (rows) =>
      flat
        ? out.batch('categories', rows.map(checkboxOf))
        : out.text('categories', rows.map((row) => nest.node(row.depth, checkboxOf(row))).join('')),
    );
    await out.text('categories', nest.end());
  });
}

/** cChangesets.list (cchangesets.cfc:95-139): the page of change sets with the feed iterator's paging, and the category tree. */
async function listBody(ctx: ContentRouteContext, actor: Actor, rc: Rc): Promise<Readable> {
  const page = await listChangesets(ctx.domain, actor, rc);
  // list.cfm previews an unpublished change set at the home page's complete URL.
  if (page.changesets.some((bean) => !bean.published)) {
    throw siteSettingsUnavailable('cChangesets.list prints preview URLs built from site settings this service does not hold');
  }
  const { recordCount, nextN, pageIndex } = page;
  const first = (pageIndex - 1) * nextN;
  return categoryTreeBody(ctx, actor, requiredRcText(rc, 'siteid'), false, (count, categories) => ({
    rc: {
      changesets: {
        pageIndex,
        pageCount: Math.ceil(recordCount / nextN),
        recordCount,
        firstRecordOnPageIndex: first > recordCount ? 1 : first + 1,
        lastRecordOnPageIndex: Math.min(first + nextN, recordCount),
        items: page.changesets.map(beanValues),
      },
      categoryCount: count,
      categories,
    },
  }));
}

/** What edit.cfm reads besides the menu, in the answer `wrap` puts it in: the bean, `hasPendingApprovals()` of an unpublished one, and the category rows. */
async function editBody(
  ctx: ContentRouteContext,
  actor: Actor,
  bean: ChangesetBean,
  siteId: string,
  wrap: (rc: Rc) => AdminViewModel | AdminWriteResult,
): Promise<Readable> {
  const pending = bean.published ? undefined : await pendingApprovalCount(ctx.domain, actor, bean.changesetid);
  return categoryTreeBody(ctx, actor, siteId, true, (count, categories) =>
    wrap({
      changeset: beanValues(bean),
      ...(pending === undefined ? {} : { hasPendingApprovals: pending }),
      categoryCount: count,
      categories,
    }),
  );
}

/** Each list's assigned versions with the `getCrumbList(contentid, rc.siteid, false, path)` crumbs and node verdict the view prints, read on `tx` for all lists at once. */
async function assignmentRows(
  tx: TenantTx,
  ctx: ContentRouteContext,
  actor: Actor,
  siteId: string,
  memberships: UserMemberships,
  lists: readonly (readonly AssignmentRow[])[],
): Promise<Rc[][]> {
  const rows = lists.flat();
  const items = rows.map((row) => ({ contentId: row.contentid ?? '', ...(row.path === null ? {} : { path: row.path }) }));
  const crumbLists = await getCrumbListsInTx(tx, ctx.domain.repository, { siteId, items });
  const verdicts = await getNodePermsInTx(tx, ctx.domain, actor, crumbLists, memberships);
  const out = rows.map((row, at): Rc => ({
    ...rowValues(row),
    verdict: verdicts[at] ?? 'none',
    crumbdata: (crumbLists[at] ?? []).map((crumb) => ({ ...rowValues(crumb), icon: iconClass(NO_CUSTOM_ICONS, crumb) })),
  }));
  let offset = 0;
  return lists.map((list) => {
    offset += list.length;
    return out.slice(offset - list.length, offset);
  });
}

/** cChangesets.assignments (cchangesets.cfc:156-164): the change set and its assigned versions per module, streamed batch by batch. */
function assignmentsBody(ctx: ContentRouteContext, actor: Actor, rc: Rc): Promise<Readable> {
  const siteId = requiredRcText(rc, 'siteid');
  const args = { changesetId: requiredRcText(rc, 'changesetid'), keywords: rcText(rc, 'keywords') };
  const variations = ctx.domain.config.variations;
  const lists: AssignmentKey[] = [ASSIGNMENT_KEYS.component, ASSIGNMENT_KEYS.form, ...(variations ? [ASSIGNMENT_KEYS.variation] : [])];
  return streamModel(lists, async (out) => {
    // Read before the cursor's transaction holds a connection; a failure still surfaces after the 503 checks.
    const viewerMemberships = await settled(loadMemberships(ctx.domain, actor));
    await readAssignmentBatches(ctx.domain, actor, args, (changeset, hasSiteAssignments) => {
      // The menu's change-set preview and every site architecture row's preview print complete content URLs.
      if (!changeset.published || hasSiteAssignments) {
        throw siteSettingsUnavailable('cChangesets.assignments prints preview URLs built from site settings this service does not hold');
      }
      const memberships = viewerMemberships();
      out.head((slot) => ({
        rc: {
          changeset: beanValues(changeset),
          siteAssignments: [],
          componentAssignments: slot.componentAssignments,
          formAssignments: slot.formAssignments,
          ...(variations ? { variationAssignments: slot.variationAssignments } : {}),
        },
      }));
      return async (list, rows, tx) => {
        const [values = []] = await assignmentRows(tx, ctx, actor, siteId, memberships, [rows]);
        return out.batch(ASSIGNMENT_KEYS[list], values);
      };
    });
  });
}

/** The contract outcome of an action that redirects whether or not it wrote. */
function redirected(saved: boolean, redirect: AdminWriteResult['redirect']): AdminWriteResult {
  return { saved, errors: {}, redirect };
}

/** Registers the cchangesets operations the contract lists; `cChangesets.publish` is withheld and stays on legacy. */
export async function registerChangesetRoutes(app: FastifyInstance, ctx: ContentRouteContext): Promise<void> {
  /** cChangesets.list: one page of the site's change sets narrowed by the filters. */
  app.get<{ Params: SiteParams }>(LIST_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const body = await listBody(ctx, actor, requestRc(request, request.params));
    return reply.type(VIEW_MODEL_CONTENT_TYPE).send(body);
  });

  /** cChangesets.save: `read(rc.changesetID).set(rc).save()` once the token validates, then the list redirect or the edit view. */
  app.post<{ Params: SiteParams }>(LIST_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request, reply): Promise<AdminWriteResult | FastifyReply> => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const rc = requestRc(request, request.params);
    // save() reads `arguments.rc.changesetid` as its CSRF context, failing without it (cchangesets.cfc:178).
    const changesetId = rcText(rc, 'changesetid');
    if (changesetId === undefined) throw legacyFault('Element RC.changesetid is undefined in ARGUMENTS.');
    if (!(await changesetTokenValid(request, reply, changesetId))) {
      // Legacy leaves `rc.changeset` undefined, and save.cfm's include of edit.cfm fails reading it.
      return { saved: false, errors: {}, redirect: null, data: { rc: {} } };
    }
    const result = await saveChangeset(ctx.domain, actor, rc);
    setRc(rc, 'changesetID', result.changeset.changesetid);
    if (result.redirect) {
      return { saved: true, errors: {}, redirect: adminRedirect('cChangesets.list', rc, ['changesetID', 'siteID']) };
    }
    // The menu prints nothing for the `save` action, so the re-rendered view needs no preview link.
    const body = await editBody(ctx, actor, result.changeset, request.params.siteid, (model) => ({ saved: false, errors: result.errors, redirect: null, data: { rc: model } }));
    return reply.type(VIEW_MODEL_CONTENT_TYPE).send(body);
  });

  /** cChangesets.edit: `changesetManager.read(rc.changesetID)` and the edit view's data. */
  app.get<{ Params: ChangesetParams }>(CHANGESET_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const bean = await readChangeset(ctx.domain, actor, request.params.changesetid);
    // The menu previews a stored, unpublished change set at the site's complete web path.
    if (!bean.isnew && !bean.published) {
      throw siteSettingsUnavailable('cChangesets.edit prints a preview URL built from site settings this service does not hold');
    }
    const body = await editBody(ctx, actor, bean, request.params.siteid, (rc) => ({ rc }));
    return reply.type(VIEW_MODEL_CONTENT_TYPE).send(body);
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
  app.get<{ Params: ChangesetParams }>(ASSIGNMENTS_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const body = await assignmentsBody(ctx, actor, requestRc(request, request.params));
    return reply.type(VIEW_MODEL_CONTENT_TYPE).send(body);
  });

  /**
   * cChangesets.removeitem: detaches the posted `rc.contenthistID` once the token validates; always the assignments
   * redirect. A valid token without that field fails as legacy's read of it does, the token consumed and nothing written.
   */
  app.post<{ Params: ItemParams; Reply: AdminWriteResult }>(REMOVE_ITEM_PATH, { config: circuitRouteConfig(CIRCUIT) }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, CIRCUIT, request.params.siteid);
    const { siteid, changesetid } = request.params;
    const rc = requestRc(request, { siteid, changesetid });
    const changesetId = requiredRcText(rc, 'changesetid');
    const valid = await changesetTokenValid(request, reply, changesetId);
    if (valid) {
      const contentHistId = rcText(rc, 'contenthistid');
      if (contentHistId === undefined) throw legacyFault('Element CONTENTHISTID is undefined in RC.');
      await removeItem(ctx.domain, actor, changesetId, contentHistId);
    }
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
