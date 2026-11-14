/** `/v1/raw/<circuit>/<action>`: the content admin actions answered as the legacy fragment, JSON or download bytes. */
import type { Readable } from 'node:stream';
import type { Opt2RouteConfig } from '@opt2/platform/auth';
import {
  legacyParamsOf,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import type { Actor } from '../../domain/context.js';
import type { AdminRenderResult } from '../../legacy/admin-render.js';
import type { ContentRouteContext } from '../index.js';
import { adminCsrf, circuitRouteConfig, requireCircuitAccess, type ContentAdminCircuit } from './access.js';
import { carchRawActions } from './carch.js';
import { cchangesetsRawActions } from './cchangesets.js';
import { ccommentsRawActions } from './ccomments.js';
import { cfeedRawActions } from './cfeed.js';
import { cformRawActions } from './cform.js';
import { cnavRawActions } from './cnav.js';

/** A raw entry's answer: a renderer's result, whose download body may be a stream. */
export type RawActionResult = Omit<AdminRenderResult, 'body'> & { body: AdminRenderResult['body'] | Readable };

/** Raw admin response entry: renders one legacy fragment, JSON or download. */
export interface RawActionSpec {
  run(request: FastifyRequest, ctx: ContentRouteContext, actor: Actor): Promise<RawActionResult>;
  /** The `validateCSRFTokens` context, only where the action validates its token before anything else. */
  csrfContext?: (request: FastifyRequest) => string;
}

/** HTTP methods of the raw operations. */
export type RawMethod = 'GET' | 'POST';

/** One contract operation under `/v1/raw/<circuit>/<action>`, with the route `config` it is registered with. */
export interface RawOperation {
  readonly circuit: ContentAdminCircuit;
  readonly action: string;
  readonly method: RawMethod;
  readonly url: string;
  readonly operationId: string;
  readonly config: { opt2: Opt2RouteConfig };
}

/** A contract path: its circuit, action and the operationId of each method. */
interface RawPathRow {
  readonly circuit: ContentAdminCircuit;
  readonly action: string;
  readonly operations: Readonly<Partial<Record<RawMethod, string>>>;
}

// Mirrors contracts/openapi.yaml `/v1/raw/**`, which is never parsed at runtime. Every operation's `x-opt2-requires`
// (cnav: `x-opt2-public`) is its circuit's, so each takes `circuitRouteConfig(circuit)`.
const RAW_PATHS: readonly RawPathRow[] = [
  { circuit: 'carch', action: 'approvalaction', operations: { GET: 'raw_carch_approvalaction', POST: 'raw_carch_approvalaction_post' } },
  { circuit: 'carch', action: 'assocfiles', operations: { GET: 'raw_carch_assocfiles', POST: 'raw_carch_assocfiles_post' } },
  { circuit: 'carch', action: 'availablechangesets', operations: { GET: 'raw_carch_availablechangesets', POST: 'raw_carch_availablechangesets_post' } },
  { circuit: 'carch', action: 'downloaddata', operations: { GET: 'raw_carch_downloaddata', POST: 'raw_carch_downloaddata_post' } },
  { circuit: 'carch', action: 'draftpromptdata', operations: { GET: 'raw_carch_draftpromptdata', POST: 'raw_carch_draftpromptdata_post' } },
  { circuit: 'carch', action: 'getaudittrail', operations: { GET: 'raw_carch_getaudittrail', POST: 'raw_carch_getaudittrail_post' } },
  { circuit: 'carch', action: 'getimagesizeurl', operations: { GET: 'raw_carch_getimagesizeurl', POST: 'raw_carch_getimagesizeurl_post' } },
  { circuit: 'carch', action: 'loadcategoryassignment', operations: { GET: 'raw_carch_loadcategoryassignment', POST: 'raw_carch_loadcategoryassignment_post' } },
  { circuit: 'carch', action: 'loadcategoryfeaturestartstop', operations: { GET: 'raw_carch_loadcategoryfeaturestartstop', POST: 'raw_carch_loadcategoryfeaturestartstop_post' } },
  { circuit: 'carch', action: 'loadclass', operations: { GET: 'raw_carch_loadclass', POST: 'raw_carch_loadclass_post' } },
  { circuit: 'carch', action: 'loadclassconfigurator', operations: { GET: 'raw_carch_loadclassconfigurator', POST: 'raw_carch_loadclassconfigurator_post' } },
  { circuit: 'carch', action: 'loaddiff', operations: { GET: 'raw_carch_loaddiff', POST: 'raw_carch_loaddiff_post' } },
  { circuit: 'carch', action: 'loadexpirenotify', operations: { GET: 'raw_carch_loadexpirenotify', POST: 'raw_carch_loadexpirenotify_post' } },
  { circuit: 'carch', action: 'loadextendedattributes', operations: { GET: 'raw_carch_loadextendedattributes', POST: 'raw_carch_loadextendedattributes_post' } },
  { circuit: 'carch', action: 'loadfilemetadata', operations: { GET: 'raw_carch_loadfilemetadata', POST: 'raw_carch_loadfilemetadata_post' } },
  { circuit: 'carch', action: 'loadnewcontentmenu', operations: { GET: 'raw_carch_loadnewcontentmenu', POST: 'raw_carch_loadnewcontentmenu_post' } },
  { circuit: 'carch', action: 'loadnotify', operations: { GET: 'raw_carch_loadnotify', POST: 'raw_carch_loadnotify_post' } },
  { circuit: 'carch', action: 'loadquickedit', operations: { GET: 'raw_carch_loadquickedit', POST: 'raw_carch_loadquickedit_post' } },
  { circuit: 'carch', action: 'loadrelatedcontent', operations: { GET: 'raw_carch_loadrelatedcontent', POST: 'raw_carch_loadrelatedcontent_post' } },
  { circuit: 'carch', action: 'loadselectedrelatedcontent', operations: { GET: 'raw_carch_loadselectedrelatedcontent', POST: 'raw_carch_loadselectedrelatedcontent_post' } },
  { circuit: 'carch', action: 'loadsiteflat', operations: { GET: 'raw_carch_loadsiteflat', POST: 'raw_carch_loadsiteflat_post' } },
  { circuit: 'carch', action: 'loadsitemanager', operations: { GET: 'raw_carch_loadsitemanager', POST: 'raw_carch_loadsitemanager_post' } },
  { circuit: 'carch', action: 'loadsitesection', operations: { GET: 'raw_carch_loadsitesection', POST: 'raw_carch_loadsitesection_post' } },
  { circuit: 'carch', action: 'loadtagarray', operations: { GET: 'raw_carch_loadtagarray', POST: 'raw_carch_loadtagarray_post' } },
  { circuit: 'carch', action: 'lockfile', operations: { GET: 'raw_carch_lockfile', POST: 'raw_carch_lockfile_post' } },
  { circuit: 'carch', action: 'refreshsitesection', operations: { GET: 'raw_carch_refreshsitesection', POST: 'raw_carch_refreshsitesection_post' } },
  { circuit: 'carch', action: 'savecopyinfo', operations: { GET: 'raw_carch_savecopyinfo', POST: 'raw_carch_savecopyinfo_post' } },
  { circuit: 'carch', action: 'savequickedit', operations: { GET: 'raw_carch_savequickedit', POST: 'raw_carch_savequickedit_post' } },
  { circuit: 'carch', action: 'sitemanagertab', operations: { GET: 'raw_carch_sitemanagertab', POST: 'raw_carch_sitemanagertab_post' } },
  { circuit: 'carch', action: 'siteparents', operations: { GET: 'raw_carch_siteparents', POST: 'raw_carch_siteparents_post' } },
  { circuit: 'carch', action: 'statusmodal', operations: { GET: 'raw_carch_statusmodal', POST: 'raw_carch_statusmodal_post' } },
  { circuit: 'carch', action: 'unlockfile', operations: { GET: 'raw_carch_unlockfile', POST: 'raw_carch_unlockfile_post' } },
  { circuit: 'carch', action: 'unlocknode', operations: { GET: 'raw_carch_unlocknode', POST: 'raw_carch_unlocknode_post' } },
  { circuit: 'carch', action: 'update', operations: { GET: 'raw_carch_update', POST: 'raw_carch_update_post' } },
  { circuit: 'cchangesets', action: 'loadtagarray', operations: { GET: 'raw_cchangesets_loadtagarray', POST: 'raw_cchangesets_loadtagarray_post' } },
  { circuit: 'ccomments', action: 'ajax', operations: { GET: 'raw_ccomments_ajax', POST: 'raw_ccomments_ajax_post' } },
  { circuit: 'ccomments', action: 'loadcomments', operations: { GET: 'raw_ccomments_loadcomments', POST: 'raw_ccomments_loadcomments_post' } },
  { circuit: 'ccomments', action: 'loadcommentspage', operations: { GET: 'raw_ccomments_loadcommentspage', POST: 'raw_ccomments_loadcommentspage_post' } },
  { circuit: 'cfeed', action: 'loadsite', operations: { GET: 'raw_cfeed_loadsite', POST: 'raw_cfeed_loadsite_post' } },
  { circuit: 'cfeed', action: 'siteparents', operations: { GET: 'raw_cfeed_siteparents', POST: 'raw_cfeed_siteparents_post' } },
  { circuit: 'cfeed', action: 'update', operations: { GET: 'raw_cfeed_update', POST: 'raw_cfeed_update_post' } },
  { circuit: 'cform', action: 'export', operations: { GET: 'raw_cform_export', POST: 'raw_cform_export_post' } },
  { circuit: 'cform', action: 'getdataset', operations: { GET: 'raw_cform_getdataset', POST: 'raw_cform_getdataset_post' } },
  { circuit: 'cform', action: 'getdialog', operations: { GET: 'raw_cform_getdialog', POST: 'raw_cform_getdialog_post' } },
  { circuit: 'cform', action: 'getfield', operations: { GET: 'raw_cform_getfield', POST: 'raw_cform_getfield_post' } },
  { circuit: 'cform', action: 'getfieldtemplate', operations: { GET: 'raw_cform_getfieldtemplate', POST: 'raw_cform_getfieldtemplate_post' } },
  { circuit: 'cform', action: 'getfieldtype', operations: { GET: 'raw_cform_getfieldtype', POST: 'raw_cform_getfieldtype_post' } },
  { circuit: 'cform', action: 'getform', operations: { GET: 'raw_cform_getform', POST: 'raw_cform_getform_post' } },
  { circuit: 'cnav', action: 'searchsitedata', operations: { GET: 'raw_cnav_searchsitedata', POST: 'raw_cnav_searchsitedata_post' } },
];

/** Every raw operation the contract lists, one per method, in contract order. */
export const RAW_OPERATIONS: readonly RawOperation[] = Object.freeze(
  RAW_PATHS.flatMap(({ circuit, action, operations }) =>
    (Object.entries(operations) as Array<[RawMethod, string]>).map(
      ([method, operationId]): RawOperation =>
        Object.freeze({ circuit, action, method, url: `/v1/raw/${circuit}/${action}`, operationId, config: circuitRouteConfig(circuit) }),
    ),
  ),
);

const carch: Readonly<Record<string, RawActionSpec>> = carchRawActions;
const cchangesets: Readonly<Record<string, RawActionSpec>> = cchangesetsRawActions;
const ccomments: Readonly<Record<string, RawActionSpec>> = ccommentsRawActions;
const cfeed: Readonly<Record<string, RawActionSpec>> = cfeedRawActions;
const cform: Readonly<Record<string, RawActionSpec>> = cformRawActions;
const cnav: Readonly<Record<string, RawActionSpec>> = cnavRawActions;

/** Each circuit's raw entries by action; ccategory and cchain answer no raw response. */
const RAW_ACTIONS: Readonly<Record<ContentAdminCircuit, Readonly<Record<string, RawActionSpec>>>> = Object.freeze({
  carch,
  cchangesets,
  ccomments,
  ccategory: {},
  cfeed,
  cchain: {},
  cform,
  cnav,
});

/** The circuit's own entry for `action`, never an inherited property. */
function rawActionOf(circuit: ContentAdminCircuit, action: string): RawActionSpec | undefined {
  const actions = RAW_ACTIONS[circuit];
  return Object.hasOwn(actions, action) ? actions[action] : undefined;
}

/** `rc.siteid` as admin/Application.cfc:401-412 settles it: the url or form value, else the session's site, the token's. */
function siteIdOf(request: FastifyRequest): string {
  const rc = legacyParamsOf(request);
  const key = Object.keys(rc).find((name) => name.toLowerCase() === 'siteid');
  const value = key === undefined ? undefined : rc[key];
  return typeof value === 'string' && value !== '' ? value : (request.opt2Auth.user?.site ?? '');
}

/** The handler of one raw entry: circuit gate, the entry's CSRF consume, then its legacy bytes unchanged. */
function rawHandler(
  app: FastifyInstance,
  ctx: ContentRouteContext,
  circuit: ContentAdminCircuit,
  spec: RawActionSpec,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  const csrf = spec.csrfContext === undefined ? undefined : adminCsrf(spec.csrfContext);
  return async (request, reply) => {
    const actor = await requireCircuitAccess(request, ctx, circuit, siteIdOf(request));
    if (csrf !== undefined) await csrf.call(app, request, reply);
    const out = await spec.run(request, ctx, actor);
    const headers: Record<string, string> = { 'content-type': out.contentType };
    // A cflocation result names its target in `redirect`; a `Location` the entry sets itself wins.
    if (out.redirect !== undefined) headers.location = out.redirect;
    return sendLegacyResponse(reply, { status: out.status, headers: { ...headers, ...out.headers }, body: out.body });
  };
}

/**
 * Registers every /v1/raw/<circuit>/<action> operation the contract lists.
 * @throws Error At start-up, before registering any route, when a listed operation has no raw entry.
 */
export async function registerRawRoutes(app: FastifyInstance, ctx: ContentRouteContext): Promise<void> {
  const routes = RAW_OPERATIONS.map((operation) => {
    const spec = rawActionOf(operation.circuit, operation.action);
    if (spec === undefined) {
      throw new Error(`${operation.method} ${operation.url} (${operation.operationId}): ${operation.circuit} has no raw action ${operation.action}`);
    }
    return { operation, spec };
  });
  for (const { operation, spec } of routes) {
    app.route({
      method: operation.method,
      url: operation.url,
      config: operation.config,
      handler: rawHandler(app, ctx, operation.circuit, spec),
    });
  }
}
