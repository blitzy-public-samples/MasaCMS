// The cchain controller `before()` and the carried approval-chain actions for the screen registry (server-only).
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import { assignContext, type RequestContext } from '@/lib/request-context';
import type { PageScreen, RedirectScreen, ScreenContext, ScreenDefinition, SubmitResult } from '../registry';
import { submitCchainDelete } from './delete';
import { loadCchainList, renderCchainList } from './list';
import { loadCchainPending, renderCchainPending } from './pending';
import { submitCchainSave } from './save';
import { loadCchainUpdate, renderCchainUpdate } from './update';

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

/** cchain `before()`: S2 or the site's private-pool Admin (`Admin;<privateUserPoolID>;0`); otherwise `secure()`. */
export const cchainGate: ScreenGate = (req, { secure }) => (req.isSiteAdmin || req.isS2 ? ALLOW : secure());

/** The `param` defaults `before()` gives every cchain action once the gate lets it through. */
export const CCHAIN_RC_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  chainid: '',
  name: '',
  description: '',
  userid: '',
  groupid: '',
  requestid: '',
  actionid: '',
  actiontype: '',
});

/** `rc` plus each {@link CCHAIN_RC_DEFAULTS} key it lacks in any case; present values, empty ones included, stay. */
export function withCchainDefaults(rc: RequestContext): RequestContext {
  const present = new Set(Object.keys(rc).map((name) => name.toLowerCase()));
  const missing = Object.entries(CCHAIN_RC_DEFAULTS).filter(([name]) => !present.has(name));
  return assignContext(rc, Object.fromEntries(missing));
}

/** Gives `ctx.req.rc` the `before()` defaults, so the action and the view it renders both read them. */
function withRcDefaults(ctx: ScreenContext): ScreenContext {
  ctx.req = { ...ctx.req, rc: withCchainDefaults(ctx.req.rc) };
  return ctx;
}

const CCHAIN = { circuit: 'cchain', owner: 'strategies-content', gate: cchainGate } as const;

/** A gated cchain view whose load runs after the `before()` defaults. */
function pageScreen<D>(
  action: string,
  load: (ctx: ScreenContext) => Promise<D>,
  render: PageScreen<D>['render'],
): PageScreen<D> {
  return Object.freeze({
    ...CCHAIN,
    action,
    mode: 'page',
    load: (ctx: ScreenContext) => load(withRcDefaults(ctx)),
    render,
  });
}

/** A gated cchain post action whose submit runs after the `before()` defaults. */
function redirectScreen(action: string, submit: (ctx: ScreenContext) => Promise<SubmitResult>): RedirectScreen {
  return Object.freeze({
    ...CCHAIN,
    action,
    mode: 'redirect',
    submit: (ctx: ScreenContext) => submit(withRcDefaults(ctx)),
  });
}

// `cchain.edit` has no inventoried route key (edit.cfm counts as update.cfm's include), so the gateway keeps it on
// legacy and web registers no screen for it; its view is served through `cchain.update`. `dsp_secondary_menu` and
// `js` are partials the views include, not actions.
/** The carried cchain actions: the Approval Chains list, Pending Requests, the update view, save and delete. */
export const cchainScreens: readonly ScreenDefinition[] = Object.freeze([
  pageScreen('list', loadCchainList, renderCchainList),
  pageScreen('pending', loadCchainPending, renderCchainPending),
  pageScreen('update', loadCchainUpdate, renderCchainUpdate),
  redirectScreen('save', submitCchainSave),
  redirectScreen('delete', submitCchainDelete),
]);
