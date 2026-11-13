// The ccategory controller `before()` and the carried category manager actions for the screen registry (server-only).
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import { assignContext, tokenServesSite, type AdminRequest } from '@/lib/request-context';
import type { PageScreen, Rc, ScreenContext, ScreenDefinition } from '../registry';
import { loadCcategoryEdit, renderCcategoryEdit, type CcategoryEditData } from './edit';
import { loadCcategoryList, renderCcategoryList, type CcategoryListData } from './list';
import { loadUpdatedCategory, updateCategory } from './update';

export { ccategorySecondaryMenu } from './secondary-menu';

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

const CATEGORY_MODULE_ID = '00000000000000000000000000000000010';
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';

// identity mints site-admin and m:<NNN> for the token's site, while legacy checks them for getSite(rc.siteid), which
// answers `default` for an empty id; so they count only when the token serves that site. S2 is global.
/** Whether the token's site roles apply to the site `before()` checks. */
function servesRequestedSite(req: AdminRequest): boolean {
  return req.user !== undefined && tokenServesSite(req.user, req.rc['siteid'] || 'default');
}

/** ccategory `before()`: S2, the site's private-pool Admin, or Categories plus Site Manager; else `secure()`. */
export const ccategoryGate: ScreenGate = (req, { secure }) =>
  req.isS2 ||
  (servesRequestedSite(req) &&
    (req.isSiteAdmin || (req.modulePerm(CATEGORY_MODULE_ID) && req.modulePerm(SITE_MANAGER_MODULE_ID))))
    ? ALLOW
    : secure();

/** The `param` defaults of ccategory `before()`, in legacy order, as the string values an `rc` holds. */
export const CCATEGORY_RC_DEFAULTS = Object.freeze({ startrow: '1', keywords: '' } as const);

/** `rc` with each {@link CCATEGORY_RC_DEFAULTS} entry added where its key, in any case, is absent, else `rc`. */
export function applyCcategoryDefaults(rc: Rc): Rc {
  const present = new Set(Object.keys(rc).map((name) => name.toLowerCase()));
  const missing = Object.entries(CCATEGORY_RC_DEFAULTS).filter(([name]) => !present.has(name));
  return missing.length === 0 ? rc : assignContext(rc, Object.fromEntries(missing));
}

// The request is replaced on the same context: the shell and FW/1's redirect read it after the screen, and the update
// steps share their state keyed by the context object.
/** `ctx` with the `before()` defaults applied to its request. */
function withRcDefaults(ctx: ScreenContext): ScreenContext {
  const rc = applyCcategoryDefaults(ctx.req.rc);
  if (rc !== ctx.req.rc) ctx.req = { ...ctx.req, rc };
  return ctx;
}

/** `step` run on the request `before()` leaves. */
function afterBefore<A extends readonly unknown[], R>(
  step: (ctx: ScreenContext, ...rest: A) => R,
): (ctx: ScreenContext, ...rest: A) => R {
  return (ctx, ...rest) => step(withRcDefaults(ctx), ...rest);
}

/** A strategies-content page action behind the ccategory gate, each step reading the `before()` defaults. */
function pageAction<D>(
  action: string,
  steps: Pick<PageScreen<D>, 'redirect' | 'render'> & { readonly load: (ctx: ScreenContext) => Promise<D> },
): PageScreen<D> {
  const { redirect, load, render } = steps;
  return Object.freeze({
    circuit: 'ccategory',
    action,
    mode: 'page',
    owner: 'strategies-content',
    gate: ccategoryGate,
    secondaryMenu: 'ccategory',
    ...(redirect === undefined ? {} : { redirect: afterBefore(redirect) }),
    load: afterBefore(load),
    render: afterBefore(render),
  });
}

// `update` is inventoried as a page: the gateway folds the posted form into a page request, its controller step
// writes, and `update.cfm` includes `edit.cfm`. `js`, `dsp_nest`, `dsp_parents`, `dsp_secondary_menu` and
// `dsp_tab_usage` are partials, not actions.
/** The carried ccategory actions: the Categories list, the category form and its save. */
export const ccategoryScreens: readonly ScreenDefinition[] = Object.freeze([
  pageAction<CcategoryListData>('list', { load: loadCcategoryList, render: renderCcategoryList }),
  pageAction<CcategoryEditData>('edit', { load: loadCcategoryEdit, render: renderCcategoryEdit }),
  pageAction<CcategoryEditData>('update', {
    redirect: updateCategory,
    load: loadUpdatedCategory,
    render: renderCcategoryEdit,
  }),
]);
