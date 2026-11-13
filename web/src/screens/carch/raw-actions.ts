// The carch fragment, JSON and download actions strategies-content renders, relayed byte for byte (server-only).
import type { RawBody, ScreenContext, ScreenDefinition } from '../registry';
import { applyCarchDefaults, CARCH_OWNER, carchGate } from './controller';
import { relayCarchRaw, type CarchRawAction } from './service';

type RawMode = 'fragment' | 'json' | 'download';

/** Inventoried response mode of each carried carch action relayed from its `/v1/raw/carch/<action>` operation. */
const RAW_ACTION_MODES = {
  // One definition serves both inventoried branches ({action=approve} and the rest), which share one operation.
  // No CSRF field is required: legacy short-circuits its check (`true or validateCSRFTokens`); the request goes as is.
  approvalaction: 'json',
  assocfiles: 'fragment',
  availablechangesets: 'fragment',
  downloaddata: 'download',
  draftpromptdata: 'json',
  getaudittrail: 'json',
  getimagesizeurl: 'json',
  loadcategoryassignment: 'fragment',
  loadcategoryfeaturestartstop: 'fragment',
  loadclass: 'fragment',
  loadclassconfigurator: 'fragment',
  loaddiff: 'fragment',
  loadexpirenotify: 'fragment',
  loadextendedattributes: 'json',
  loadfilemetadata: 'fragment',
  loadnewcontentmenu: 'fragment',
  loadnotify: 'fragment',
  loadquickedit: 'fragment',
  loadrelatedcontent: 'fragment',
  loadselectedrelatedcontent: 'fragment',
  loadsiteflat: 'fragment',
  loadsitemanager: 'json',
  loadsitesection: 'json',
  loadtagarray: 'json',
  refreshsitesection: 'fragment',
  // Its `session.flatViewArgs` write is state strategies-content keeps; no web session value comes back to apply.
  sitemanagertab: 'json',
  siteparents: 'fragment',
  statusmodal: 'fragment',
} as const satisfies Partial<Record<CarchRawAction, RawMode>>;

type RelayedAction = keyof typeof RAW_ACTION_MODES;

/** The service's answer to `action` for the request as carch `before()` leaves it, sent with the request's method. */
async function relay(ctx: ScreenContext, action: RelayedAction): Promise<RawBody> {
  // before() runs for every carch action; its rc defaults and session writes stand on the request the handler persists.
  ctx.req = applyCarchDefaults(ctx.req);
  // AdminRequest carries no method; only a POST carries a body.
  return relayCarchRaw(ctx, action, ctx.body === undefined ? 'GET' : 'POST');
}

/** The relayed definition of `action` in its response `mode`. */
function rawActionScreen(action: RelayedAction, mode: RawMode): ScreenDefinition {
  const base = { circuit: 'carch', action, owner: CARCH_OWNER, gate: carchGate } as const;
  const run = (ctx: ScreenContext): Promise<RawBody> => relay(ctx, action);
  switch (mode) {
    case 'fragment':
      return Object.freeze({ ...base, mode, render: run });
    case 'json':
      return Object.freeze({ ...base, mode, json: run });
    case 'download':
      return Object.freeze({ ...base, mode, download: run });
  }
}

/** One definition per carried carch fragment, JSON or download action. */
export const rawActionScreens: readonly ScreenDefinition[] = Object.freeze(
  (Object.keys(RAW_ACTION_MODES) as RelayedAction[]).map((action) => rawActionScreen(action, RAW_ACTION_MODES[action])),
);
