// `cCategory.update`: the strategies-content save, then FW/1's list redirect or the form re-rendered (server-only).
import { okBody } from '@/lib/gateway-client';
import { structValue } from '../carch/model';
import type { PageControllerRedirect, PageRedirect, ScreenContext } from '../registry';
import { isStruct } from './dsp-nest';
import { categoryEditDataOf, errorEntriesOf, type CcategoryEditData } from './edit';

const SERVICE = 'strategies-content';
const OPERATION = 'saveCategory';

/** `fw.redirect(action="cCategory.list", append="siteid", path="./")`. */
const LIST_REDIRECT: PageRedirect = Object.freeze({
  kind: 'redirect',
  action: 'cCategory.list',
  append: 'siteid',
  path: './',
});

/** The form model the controller step kept for the view of the same request. */
const RERENDERS = new WeakMap<ScreenContext, CcategoryEditData>();

/**
 * `update()`: posts every rc field, the CSRF pair included, for the owner to validate and run `rc.action`. The owner's
 * redirect answers with the list; otherwise the bean and its errors are kept for the view.
 * @throws TypeError When `rc.action` is undefined, or the owner returns no bean (a rejected token), as legacy fails.
 * @throws GatewayDenialError When strategies-content answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function updateCategory(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const { rc } = ctx.req;
  // Legacy reads `rc.action` after either branch, so a request without one fails without writing.
  if (rc.action === undefined) throw new TypeError('Element RC.action is undefined in ARGUMENTS.');
  const response = await ctx.gateway.strategiesContent.call('post', '/v1/sites/{siteid}/categories', {
    params: { siteid: rc.siteid ?? '' },
    form: Object.entries(rc),
  });
  const { errors, redirect, data } = okBody(response, SERVICE, OPERATION);
  if (redirect !== null) return LIST_REDIRECT;
  const model = data?.rc;
  if (!isStruct(model) || structValue(model, 'categoryBean') === undefined) {
    throw new TypeError('Element RC.categoryBean is undefined in ARGUMENTS.');
  }
  // The contract hands the bean's error struct over at the top level, in struct order.
  RERENDERS.set(ctx, { ...categoryEditDataOf(model), errors: errorEntriesOf(errors) });
  return undefined;
}

/**
 * The form model the controller step kept, with the CSRF pair of its bean.
 * @throws Error When the controller step has not run for `ctx`.
 */
export async function loadUpdatedCategory(ctx: ScreenContext): Promise<CcategoryEditData> {
  const data = RERENDERS.get(ctx);
  if (data === undefined) throw new Error('cCategory.update loaded before its controller step ran');
  await ctx.csrf.prefetch([data.bean.categoryID]);
  return data;
}
