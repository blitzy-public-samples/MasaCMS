// The cwebservice controller `before()` and the carried Web Services (OAuth client) screens for the registry (server-only).
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import { restoreFlashContext } from '@/lib/request-context';
import type {
  PageControllerRedirect,
  PageScreen,
  Rc,
  RedirectScreen,
  ScreenContext,
  ScreenDefinition,
  SubmitResult,
} from '../registry';
import { submitDelete } from './delete';
import { loadEditState, renderEditView, type WebServiceEditState } from './edit';
import { loadList, renderList, type WebServiceListData } from './list';
import { submitSave } from './save';

type SaveView = Extract<SubmitResult, { kind: 'render' }>['view'];

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

/** cwebservice `before()` gate: S2 users pass; everyone else gets the controller's `secure()`. */
export const cwebserviceGate: ScreenGate = (req, { secure }) => (req.isS2 ? ALLOW : secure());

/** The `param` defaults of cwebservice `before()`, in legacy order, as the string values an `rc` holds. */
export const CWEBSERVICE_RC_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  clientid: '',
  clientsecret: '',
  name: '',
  description: '',
  granttype: 'basic',
  redirecturl: '',
  userid: '',
});

const DEFAULTS_KEY = 'cwebservice';

// restoreFlashContext adds a context's values only where `rc` lacks the key, matched case-insensitively, which is
// exactly CFML `param` over a struct; reusing it keeps the result a regular read-only rc view.
/** A copy of `rc` with each {@link CWEBSERVICE_RC_DEFAULTS} entry added where its key, in any case, is absent. */
export function applyCwebserviceDefaults(rc: Rc): Rc {
  return restoreFlashContext(rc, { fw1pk: DEFAULTS_KEY }, { [DEFAULTS_KEY]: CWEBSERVICE_RC_DEFAULTS });
}

// FW/1 runs `before()` ahead of the action's first step and its params only once the gate let the request through;
// the handler passes this one context on to every later step (the view and the shell), so they read the defaults too.
/** `ctx` with its request's rc replaced by {@link applyCwebserviceDefaults} of it. */
function afterBefore(ctx: ScreenContext): ScreenContext {
  ctx.req = { ...ctx.req, rc: applyCwebserviceDefaults(ctx.req.rc) };
  return ctx;
}

const CWEBSERVICE = { circuit: 'cwebservice', owner: 'identity', gate: cwebserviceGate } as const;

const listDefinition: PageScreen<WebServiceListData> = Object.freeze({
  ...CWEBSERVICE,
  action: 'list',
  mode: 'page',
  load: (ctx: ScreenContext) => loadList(afterBefore(ctx)),
  render: renderList,
});

// The inventory has no route key for this view-only action, since save.cfm includes edit.cfm, so the gateway keeps
// it on legacy; it is registered for the reproduced screen all the same, in the mode of its view.
const editDefinition: PageScreen<WebServiceEditState> = Object.freeze({
  ...CWEBSERVICE,
  action: 'edit',
  mode: 'page',
  load: (ctx: ScreenContext) => loadEditState(afterBefore(ctx)),
  render: renderEditView,
});

/** The edit view save() re-rendered on validation errors, kept from the controller step for the same request. */
const saveViews = new WeakMap<ScreenContext, SaveView>();

/** save(): its list redirect answers the request; a validation re-render is kept for `render`. */
async function saveStep(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const outcome = await submitSave(afterBefore(ctx));
  if (outcome.kind === 'redirect' || outcome.kind === 'location') return outcome;
  if (outcome.kind === 'render') saveViews.set(ctx, outcome.view);
  return undefined;
}

/**
 * The view save() left to render.
 * @throws Error When the controller step kept no view for `ctx`.
 */
function renderSaved(ctx: ScreenContext): SaveView {
  const view = saveViews.get(ctx);
  if (view === undefined) throw new Error('cwebservice.save rendered without a view from its controller step');
  return view;
}

// Inventoried as a page, as save.cfm is its view: the gateway folds the posted form into a page request, and the
// controller step writes before the view renders.
const saveDefinition: PageScreen<undefined> = Object.freeze({
  ...CWEBSERVICE,
  action: 'save',
  mode: 'page',
  redirect: saveStep,
  render: renderSaved,
});

const deleteDefinition: RedirectScreen = Object.freeze({
  ...CWEBSERVICE,
  action: 'delete',
  mode: 'redirect',
  submit: (ctx: ScreenContext) => submitDelete(afterBefore(ctx)),
});

/** The carried cwebservice actions, each identity-owned behind the cwebservice `before()`: list, edit, save, delete. */
export const cwebserviceScreens: readonly ScreenDefinition[] = Object.freeze([
  listDefinition,
  editDefinition,
  saveDefinition,
  deleteDefinition,
]);
