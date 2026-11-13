// The ccomments circuit's controller gate, site default and strategies-content relay (server-only).
import type { ScreenGate } from '@/lib/access-gate';
import { assertNotDenied, type GatewayResponse } from '@/lib/gateway-client';
import { administersRequestedSite, servesRequestedSite, type AdminRequest } from '@/lib/request-context';
import type { RawBody, ScreenContext, ScreenOwner } from '../registry';

/** Comments module id. */
export const COMMENTS_MODULE_ID = '00000000000000000000000000000000015';

/** Site Manager (content) module id. */
export const CONTENT_MODULE_ID = '00000000000000000000000000000000000';

/** Service that owns every ccomments action. */
export const CCOMMENTS_OWNER = 'strategies-content' as const satisfies ScreenOwner;

/** A ccomments action whose answer is a bare body. */
export type CommentsRawAction = 'ajax' | 'loadcomments' | 'loadcommentspage' | 'bulkedit' | 'singleedit';

const RAW_VIEW_PATHS = {
  ajax: '/v1/raw/ccomments/ajax',
  loadcomments: '/v1/raw/ccomments/loadcomments',
  loadcommentspage: '/v1/raw/ccomments/loadcommentspage',
} as const;

/** `rc.siteid`, else the session site. */
export function commentsSiteId(req: AdminRequest): string {
  const siteid = req.rc['siteid'];
  return siteid === undefined || siteid === '' ? req.session.siteid : siteid;
}

/** The ccomments controller `before()`: S2 or the site's admins, or comments and content module access on that site. */
export const ccommentsGate: ScreenGate = (req, { secure }) =>
  administersRequestedSite(req) ||
  (servesRequestedSite(req) && req.modulePerm(COMMENTS_MODULE_ID) && req.modulePerm(CONTENT_MODULE_ID))
    ? { kind: 'allow' }
    : secure();

// AdminRequest carries the FW/1 context rather than the raw scopes; it is what the legacy controller reads.
/** The request's parameters under their legacy names, except `siteid`, which travels as the contract's own field. */
function actionParams(req: AdminRequest): Record<string, string> {
  return Object.fromEntries(Object.entries(req.rc).filter(([name]) => name.toLowerCase() !== 'siteid'));
}

// The views set only their content type; every other service header is web's own legacy base set or transport framing.
/** The service's status, content type, bytes and cookies, unchanged. */
function rawBodyOf(response: GatewayResponse<Buffer>, operation: string): RawBody {
  assertNotDenied(response, CCOMMENTS_OWNER, operation);
  const contentType = [response.headers['content-type'] ?? []].flat()[0];
  if (contentType === undefined) throw new TypeError(`${operation} answered without a Content-Type`);
  return {
    status: response.status,
    contentType,
    body: response.body,
    ...(response.setCookies.length > 0 ? { setCookies: [...response.setCookies] } : {}),
  };
}

// The contract serves bulkEdit and singleEdit as writes and the ajax view they render as its own raw operation.
// Legacy runs each edit inside a catch-all and renders the view whatever the outcome, so only a denial stops it.
/** Runs the edit through its contract operation, then returns the `ccomments.ajax` view. */
async function relayEdit(ctx: ScreenContext, action: 'bulkedit' | 'singleedit', siteid: string): Promise<RawBody> {
  const facade = ctx.gateway.strategiesContent;
  const form = actionParams(ctx.req);
  if (action === 'bulkedit') {
    const written = await facade.raw('post', '/v1/sites/{siteid}/comments/bulk', { params: { siteid }, form });
    assertNotDenied(written, CCOMMENTS_OWNER, 'POST /v1/sites/{siteid}/comments/bulk');
  } else {
    const commentid = ctx.req.rc['commentid'] ?? '';
    const written = await facade.raw('post', '/v1/sites/{siteid}/comments/{commentid}', {
      params: { siteid, commentid },
      form,
    });
    assertNotDenied(written, CCOMMENTS_OWNER, 'POST /v1/sites/{siteid}/comments/{commentid}');
  }
  const view = await facade.raw('get', '/v1/raw/ccomments/ajax', { query: { siteid } });
  return rawBodyOf(view, 'GET /v1/raw/ccomments/ajax');
}

/**
 * The strategies-content answer to a ccomments fragment or ajax action, as the service rendered it.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 * @throws GatewayDenialError When strategies-content refuses the request (401 or 403).
 */
export async function relayCommentsRaw(ctx: ScreenContext, action: CommentsRawAction): Promise<RawBody> {
  const siteid = commentsSiteId(ctx.req);
  if (action === 'bulkedit' || action === 'singleedit') return relayEdit(ctx, action, siteid);
  const path = RAW_VIEW_PATHS[action];
  const params = actionParams(ctx.req);
  const facade = ctx.gateway.strategiesContent;
  // AdminRequest has no method; only a POST carries a body here, and a Content-Type announces it.
  if (ctx.req.headers.has('content-type')) {
    return rawBodyOf(await facade.raw('post', path, { query: { siteid }, form: params }), `POST ${path}`);
  }
  return rawBodyOf(await facade.raw('get', path, { query: { siteid, params } }), `GET ${path}`);
}
