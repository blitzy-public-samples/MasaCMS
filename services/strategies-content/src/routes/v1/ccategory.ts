/** ccategory admin routes: category list, edit and update. */
import type { Readable } from 'node:stream';
import { LegacyApiError, LegacyFaultError, cfEq, cfNumberString } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  readCategory,
  readCategoryWalkBatches,
  restrictGroups,
  updateCategoryAction,
  type CategoryBean,
  type CategoryInput,
  type RestrictGroupRow,
} from '../../domain/categories.js';
import type { Actor } from '../../domain/context.js';
import type { components } from '../../generated/openapi.js';
import type { CategoryWalkRow } from '../../repo/repository.js';
// Type-only: ../index.ts imports this module.
import type { ContentRouteContext } from '../index.js';
import { adminCsrf, adminRedirect, circuitRouteConfig, csrfRejected, requireCircuitAccess, type AdminWriteResult } from './access.js';
import { VIEW_MODEL_CONTENT_TYPE, nestedJson, streamModel } from './streamed-model.js';

type AdminViewModel = components['schemas']['AdminViewModel'];

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
  isOpen: CategoryWalkRow['isopen'];
  isInterestGroup: CategoryWalkRow['isinterestgroup'];
  isActive: CategoryWalkRow['isactive'];
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

/** A `getCategories` row as the contract names its columns, without its children; a SQL NULL text reads as `''`, as in a CFML query. */
function categoryNodeOf(row: CategoryWalkRow): Omit<CategoryNode, 'children'> {
  return {
    categoryID: row.categoryid,
    parentID: row.parentid ?? '',
    name: row.name ?? '',
    hasKids: row.haskids,
    isOpen: row.isopen,
    isInterestGroup: row.isinterestgroup,
    isActive: row.isactive,
    restrictGroups: row.restrictgroups ?? '',
  };
}

/**
 * The model `build` sets, its `categories` slot printing the `dsp_nest.cfm` walk batch by batch, each row with the level below it.
 * @throws Error Before any byte, when a category is its own ancestor, where legacy recursion would not end.
 */
function categoryTreeBody(ctx: ContentRouteContext, actor: Actor, build: (categories: string) => AdminViewModel | AdminWriteResult): Promise<Readable> {
  return streamModel(['categories'], async (out) => {
    out.head((slot) => build(slot.categories));
    const nest = nestedJson('children');
    await readCategoryWalkBatches(ctx.domain, actor, 'every', (rows) =>
      out.text('categories', rows.map((row) => nest.node(row.depth, categoryNodeOf(row))).join('')),
    );
    await out.text('categories', nest.end());
  });
}

/** The `edit.cfm` model: the bean's values with its errors, the restrict groups and the category tree's slot. */
function editRc(bean: CategoryBean, groups: readonly RestrictGroupRow[], categories: string): AdminViewModel['rc'] {
  return {
    categoryBean: { ...bean },
    rsRestrictGroups: groups.map((group) => ({ userID: group.userid, groupName: group.groupname, isPublic: group.ispublic })),
    categories,
  };
}

/** Registers `listCategories`, `getCategory` and `saveCategory`. */
export async function registerCategoryRoutes(app: FastifyInstance, ctx: ContentRouteContext): Promise<void> {
  app.get<{ Params: SiteParams }>(CATEGORIES_PATH, { config: circuitRouteConfig('ccategory') }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, 'ccategory', request.params.siteid);
    const body = await categoryTreeBody(ctx, actor, (categories) => ({ rc: { categories } }));
    return reply.type(VIEW_MODEL_CONTENT_TYPE).send(body);
  });

  app.get<{ Params: CategoryParams }>(CATEGORY_PATH, { config: circuitRouteConfig('ccategory') }, async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, 'ccategory', request.params.siteid);
    const groups = await restrictGroups(ctx.domain, actor);
    const bean = await readCategory(ctx.domain, actor, request.params.categoryid);
    const body = await categoryTreeBody(ctx, actor, (categories) => ({ rc: editRc(bean, groups, categories) }));
    return reply.type(VIEW_MODEL_CONTENT_TYPE).send(body);
  });

  // before() runs, and update() dereferences rc.categoryid, before validateCSRFTokens can consume the token.
  const admitUpdate = async (request: FastifyRequest): Promise<void> => {
    await requireCircuitAccess(request, ctx, 'ccategory', (request.params as SiteParams).siteid);
    categoryIdOf(request);
  };

  app.post<{ Params: SiteParams }>(
    CATEGORIES_PATH,
    { config: circuitRouteConfig('ccategory'), preHandler: [admitUpdate, adminCsrf(categoryIdOf)] },
    async (request, reply): Promise<AdminWriteResult | FastifyReply> => {
      const actor = await requireCircuitAccess(request, ctx, 'ccategory', request.params.siteid);
      const rc = controllerRc(request, request.params.siteid);
      const csrfValid = !csrfRejected(request);
      const action = rcText(rc, 'action');
      // Without `action` legacy fails reading it: in the switch past a valid token, else in the redirect test (ccategory.cfc:101,116).
      if (action === undefined) {
        const fault = new LegacyFaultError(csrfValid ? 'Element ACTION is undefined in RC.' : 'Element RC.action is undefined in ARGUMENTS.');
        throw new LegacyApiError('server_error', { stacktrace: fault.trace() });
      }
      // A refused token leaves rc.categoryBean undefined, which legacy dereferences (ccategory.cfc:116). The contract
      // answers that failure as a model without categoryBean, so the domain call, which throws for it, is skipped.
      if (!csrfValid && !cfEq(action, 'delete')) {
        return { saved: false, errors: {}, redirect: null, data: { rc: {} } };
      }
      let outcome: Awaited<ReturnType<typeof updateCategoryAction>>;
      try {
        outcome = await updateCategoryAction(ctx.domain, actor, rc, { csrfValid });
      } catch (error) {
        if (error instanceof LegacyFaultError) throw new LegacyApiError('server_error', { stacktrace: error.trace() });
        throw error;
      }
      if (outcome.kind === 'redirect') {
        return { saved: csrfValid, errors: {}, redirect: adminRedirect(outcome.action, rc, outcome.append) };
      }
      const body = await categoryTreeBody(ctx, actor, (categories) => ({
        saved: false,
        errors: outcome.bean.errors,
        redirect: null,
        data: { rc: editRc(outcome.bean, outcome.rsRestrictGroups, categories) },
      }));
      return reply.type(VIEW_MODEL_CONTENT_TYPE).send(body);
    },
  );
}
