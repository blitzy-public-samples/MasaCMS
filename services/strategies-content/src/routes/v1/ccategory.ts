/** ccategory admin routes: category list, edit and update. */
import { cfEq, cfNumberString } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  listCategories,
  readCategory,
  restrictGroups,
  updateCategoryAction,
  type CategoryBean,
  type CategoryInput,
  type RestrictGroupRow,
} from '../../domain/categories.js';
import type { Actor } from '../../domain/context.js';
import type { components } from '../../generated/openapi.js';
// Type-only: ../index.ts imports this module.
import type { ContentRouteContext } from '../index.js';
import { adminCsrf, adminRedirect, circuitRouteConfig, csrfRejected, requireCircuitAccess, type AdminWriteResult } from './access.js';

type AdminViewModel = components['schemas']['AdminViewModel'];
type CategoryListRow = Awaited<ReturnType<typeof listCategories>>[number];

interface SiteParams {
  siteid: string;
}

interface CategoryParams extends SiteParams {
  categoryid: string;
}

const CATEGORIES_PATH = '/v1/sites/:siteid/categories';
const CATEGORY_PATH = '/v1/sites/:siteid/categories/:categoryid';

/** The `param` defaults of ccategory `before()` (ccategory.cfc:90-91). */
const RC_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({ startrow: 1, keywords: '' });

/** One `categoryManager.getCategories(siteID, parentID)` row under the contract's names, with the level below it. */
interface CategoryNode {
  categoryID: string;
  /** `''` at the top of the tree. */
  parentID: string;
  name: string;
  hasKids: number;
  isOpen: CategoryListRow['isopen'];
  isInterestGroup: CategoryListRow['isinterestgroup'];
  isActive: CategoryListRow['isactive'];
  restrictGroups: string;
  children: CategoryNode[];
}

/** `rc[key]`, the key matched ignoring case, as CFML text when it is a simple value. */
function rcText(rc: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const name = Object.keys(rc).find((candidate) => candidate.toLowerCase() === key);
  const value = name === undefined ? undefined : rc[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** The controller's `rc`: url and form fields, the route's site as `siteid`, then the `before()` defaults where absent. */
function controllerRc(request: FastifyRequest, siteId: string): CategoryInput {
  const rc = legacyParamsOf(request);
  for (const name of Object.keys(rc)) {
    if (name.toLowerCase() === 'siteid') delete rc[name];
  }
  rc.siteid = siteId;
  for (const [key, value] of Object.entries(RC_DEFAULTS)) {
    if (!Object.keys(rc).some((name) => name.toLowerCase() === key)) rc[key] = value;
  }
  return rc;
}

/** `rc.categoryid`, which update() dereferences as its CSRF context; ACF fails the request when it is undefined. */
function categoryIdOf(request: FastifyRequest): string {
  const categoryId = rcText(legacyParamsOf(request), 'categoryid');
  if (categoryId === undefined) throw new Error('Element CATEGORYID is undefined in RC.');
  return categoryId;
}

/** A `getCategories` row as the contract names its columns; a SQL NULL text reads as `''`, as in a CFML query. */
function categoryNodeOf(row: CategoryListRow, children: CategoryNode[]): CategoryNode {
  return {
    categoryID: row.categoryid,
    parentID: row.parentid ?? '',
    name: row.name ?? '',
    hasKids: row.haskids,
    isOpen: row.isopen,
    isInterestGroup: row.isinterestgroup,
    isActive: row.isactive,
    restrictGroups: row.restrictgroups ?? '',
    children,
  };
}

/**
 * The `dsp_nest.cfm` walk: the category pool's level under `parentId` in name order, each row with the level below it.
 * @throws Error When a category is its own ancestor, where legacy recursion would not end.
 */
async function categoryTree(
  ctx: ContentRouteContext,
  actor: Actor,
  parentId = '',
  ancestors: ReadonlySet<string> = new Set(),
): Promise<CategoryNode[]> {
  const nodes: CategoryNode[] = [];
  for (const row of await listCategories(ctx.domain, actor, { parentId })) {
    const id = row.categoryid.toUpperCase();
    if (ancestors.has(id)) throw new Error(`Category ${row.categoryid} is its own ancestor`);
    nodes.push(categoryNodeOf(row, await categoryTree(ctx, actor, row.categoryid, new Set([...ancestors, id]))));
  }
  return nodes;
}

/** The `edit.cfm` model: the bean's values with its errors, the restrict groups and the category tree. */
async function editModel(
  ctx: ContentRouteContext,
  actor: Actor,
  bean: CategoryBean,
  groups: readonly RestrictGroupRow[],
): Promise<AdminViewModel['rc']> {
  return {
    categoryBean: { ...bean },
    rsRestrictGroups: groups.map((group) => ({ userID: group.userid, groupName: group.groupname, isPublic: group.ispublic })),
    categories: await categoryTree(ctx, actor),
  };
}

/** Registers `listCategories`, `getCategory` and `saveCategory`. */
export async function registerCategoryRoutes(app: FastifyInstance, ctx: ContentRouteContext): Promise<void> {
  app.get<{ Params: SiteParams; Reply: AdminViewModel }>(CATEGORIES_PATH, { config: circuitRouteConfig('ccategory') }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'ccategory', request.params.siteid);
    return { rc: { categories: await categoryTree(ctx, actor) } };
  });

  app.get<{ Params: CategoryParams; Reply: AdminViewModel }>(CATEGORY_PATH, { config: circuitRouteConfig('ccategory') }, async (request) => {
    const actor = await requireCircuitAccess(request, ctx, 'ccategory', request.params.siteid);
    const groups = await restrictGroups(ctx.domain, actor);
    const bean = await readCategory(ctx.domain, actor, request.params.categoryid);
    return { rc: await editModel(ctx, actor, bean, groups) };
  });

  // before() runs, and update() dereferences rc.categoryid, before validateCSRFTokens can consume the token.
  const admitUpdate = async (request: FastifyRequest): Promise<void> => {
    await requireCircuitAccess(request, ctx, 'ccategory', (request.params as SiteParams).siteid);
    categoryIdOf(request);
  };

  app.post<{ Params: SiteParams; Reply: AdminWriteResult }>(
    CATEGORIES_PATH,
    { config: circuitRouteConfig('ccategory'), preHandler: [admitUpdate, adminCsrf(categoryIdOf)] },
    async (request) => {
      const actor = await requireCircuitAccess(request, ctx, 'ccategory', request.params.siteid);
      const rc = controllerRc(request, request.params.siteid);
      const csrfValid = !csrfRejected(request);
      const action = rcText(rc, 'action');
      // A refused token leaves rc.categoryBean undefined, which legacy dereferences (ccategory.cfc:116). The contract
      // answers that failure as a model without categoryBean, so the domain call, which throws for it, is skipped.
      if (!csrfValid && action !== undefined && !cfEq(action, 'delete')) {
        return { saved: false, errors: {}, redirect: null, data: { rc: {} } };
      }
      const outcome = await updateCategoryAction(ctx.domain, actor, rc, { csrfValid });
      if (outcome.kind === 'redirect') {
        return { saved: csrfValid, errors: {}, redirect: adminRedirect(outcome.action, rc, outcome.append) };
      }
      return {
        saved: false,
        errors: outcome.bean.errors,
        redirect: null,
        data: { rc: await editModel(ctx, actor, outcome.bean, outcome.rsRestrictGroups) },
      };
    },
  );
}
