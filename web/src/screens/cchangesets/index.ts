// The cChangesets controller `before()` and the carried change-set actions for the screen registry (server-only).
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import { assignContext, tokenServesSite, type AdminRequest } from '@/lib/request-context';
import type { FragmentScreen, PageScreen, Rc, RedirectScreen, ScreenContext, ScreenDefinition } from '../registry';
import { changesetAssignmentsScreen } from './assignments';
import { changesetDeleteScreen } from './delete';
import { changesetEditScreen } from './edit';
import { changesetListScreen } from './list';
import { changesetLoadTagArrayScreen } from './loadtagarray';
import { changesetRemoveItemScreen } from './removeitem';
import { changesetRollbackScreen } from './rollback';
import { changesetSaveScreen } from './save';

export { cchangesetsSecondaryMenu } from './secondary-menu';

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

const CHANGESETS_MODULE_ID = '00000000000000000000000000000000014';
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';

// identity mints site-admin and m:<NNN> for the token's site, while legacy checks them for getSite(rc.siteid), which
// answers `default` for an empty id; so they count only when the token serves that site. S2 is global.
/** Whether the token's site roles apply to the site `before()` checks. */
function servesRequestedSite(req: AdminRequest): boolean {
  return req.user !== undefined && tokenServesSite(req.user, req.rc['siteid'] || 'default');
}

/** cChangesets `before()`: S2, the site's private-pool Admin, or Change Sets plus Site Manager; else `secure()`. */
export const cchangesetsGate: ScreenGate = (req, { secure }) =>
  req.isS2 ||
  (servesRequestedSite(req) &&
    (req.isSiteAdmin || (req.modulePerm(CHANGESETS_MODULE_ID) && req.modulePerm(SITE_MANAGER_MODULE_ID))))
    ? ALLOW
    : secure();

/** The `param` defaults of cChangesets `before()`, in legacy order, as the string values an `rc` holds. */
export const CCHANGESETS_RC_DEFAULTS = Object.freeze({
  startrow: '1',
  startdate: '',
  stopdate: '',
  page: '1',
  keywords: '',
  categoryid: '',
  tags: '',
} as const);

/** `rc` with each {@link CCHANGESETS_RC_DEFAULTS} entry added where its key, in any case, is absent, else `rc`. */
export function applyCchangesetsDefaults(rc: Rc): Rc {
  const present = new Set(Object.keys(rc).map((name) => name.toLowerCase()));
  const missing = Object.entries(CCHANGESETS_RC_DEFAULTS).filter(([name]) => !present.has(name));
  return missing.length === 0 ? rc : assignContext(rc, Object.fromEntries(missing));
}

// The request is replaced on the same context: the shell and FW/1's redirect read it after the screen, as legacy's
// layout reads the params, and a screen's steps share state keyed by the context object.
/** `ctx` with the `before()` defaults applied to its request. */
function withRcDefaults(ctx: ScreenContext): ScreenContext {
  const rc = applyCchangesetsDefaults(ctx.req.rc);
  if (rc !== ctx.req.rc) ctx.req = { ...ctx.req, rc };
  return ctx;
}

/** `step` run on the request `before()` leaves. */
function afterBefore<A extends readonly unknown[], R>(
  step: (ctx: ScreenContext, ...rest: A) => R,
): (ctx: ScreenContext, ...rest: A) => R {
  return (ctx, ...rest) => step(withRcDefaults(ctx), ...rest);
}

/** `load` behind the `before()` defaults, when the screen has one. */
function defaultedLoad<D>(
  load: ((ctx: ScreenContext) => Promise<D>) | undefined,
): { load?: (ctx: ScreenContext) => Promise<D> } {
  return load === undefined ? {} : { load: afterBefore(load) };
}

/** A page action behind the circuit gate, its controller step, load and view reading the `before()` defaults. */
function pageAction<D>(screen: Omit<PageScreen<D>, 'gate'>): PageScreen<D> {
  const { redirect, load, render } = screen;
  return Object.freeze({
    ...screen,
    gate: cchangesetsGate,
    ...(redirect === undefined ? {} : { redirect: afterBefore(redirect) }),
    ...defaultedLoad(load),
    render: afterBefore(render),
  });
}

/** A post action behind the circuit gate, its submit reading the `before()` defaults. */
function redirectAction(screen: Omit<RedirectScreen, 'gate'>): RedirectScreen {
  return Object.freeze({ ...screen, gate: cchangesetsGate, submit: afterBefore(screen.submit) });
}

/** A bare-markup action behind the circuit gate, its load and render reading the `before()` defaults. */
function fragmentAction<D>(screen: Omit<FragmentScreen<D>, 'gate'>): FragmentScreen<D> {
  const { load, render } = screen;
  return Object.freeze({ ...screen, gate: cchangesetsGate, ...defaultedLoad(load), render: afterBefore(render) });
}

// publish stays legacy-served: publishing saves approved content, which writes the withheld tcontenteventreminders
// table, so web registers no screen for it and the gateway keeps its route key on legacy.
/** The carried cChangesets actions, each behind the controller's `before()` gate and defaults. */
export const cchangesetsScreens: readonly ScreenDefinition[] = Object.freeze([
  pageAction(changesetListScreen),
  pageAction(changesetAssignmentsScreen),
  pageAction(changesetEditScreen),
  pageAction(changesetSaveScreen),
  redirectAction(changesetRollbackScreen),
  redirectAction(changesetRemoveItemScreen),
  redirectAction(changesetDeleteScreen),
  fragmentAction(changesetLoadTagArrayScreen),
]);
