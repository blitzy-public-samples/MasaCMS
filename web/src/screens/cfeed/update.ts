// `cFeed.update`: a collection add, update or delete relayed to strategies-content and answered as legacy (server-only).
import { LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import { decodeServiceBody } from '@opt2/platform/service-kit';
import type { components } from '@/generated/clients/strategies-content';
import { assertNotDenied, type GatewayResponse } from '@/lib/gateway-client';
import { NO_CACHE_HEADERS, REDIRECT_HEADERS } from '@/lib/responses';
import { loadShellData, renderAdminDocument, serializeAdminDocument } from '@/shell/document';
import type { FragmentScreen, RawBody, ScreenContext } from '../registry';
import { applyCfeedDefaults, cfeedGate } from './before';
import { renderFeedEdit } from './edit';
import { feedEditModelFrom } from './edit-model';

const SERVICE = 'strategies-content';
const PATH = '/v1/raw/cfeed/update';

type WriteResult = components['schemas']['AdminWriteResult'];

/** Service `Set-Cookie` values a bare body relays unchanged, after the request set-up's own. */
type RelayedCookies = Pick<RawBody, 'setCookies'>;

const firstValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Lower-cased media type of a `Content-Type` value. */
const mediaTypeOf = (contentType: string): string => (contentType.split(';')[0] ?? '').trim().toLowerCase();

/** The service's answer for the rc as cfeed `before()` leaves it: url fields on a GET, the form on a POST. */
function relay(ctx: ScreenContext): Promise<GatewayResponse<Buffer>> {
  const { rc } = ctx.req;
  const service = ctx.gateway.strategiesContent;
  // AdminRequest carries no method; only a POST carries a body. The CSRF pair travels with the rc fields it came in.
  if (ctx.body === undefined) return service.raw('get', PATH, { query: { params: { ...rc } } });
  return service.raw('post', PATH, {
    query: rc.siteid === undefined ? {} : { siteid: rc.siteid },
    form: Object.entries(rc),
  });
}

/** The JSON answer as the rejected save the contract sends; anything else is a contract breach. */
function rejectedSave(body: unknown, operation: string): WriteResult {
  const result = body as Partial<WriteResult> | null;
  if (typeof result !== 'object' || result === null || Array.isArray(result) || result.redirect !== null) {
    throw new TypeError(`${SERVICE} answered ${operation} with JSON that is not a rejected save`);
  }
  return result as WriteResult;
}

/** FW/1 `redirect()` to the service's `Location`, with the headers and empty body of legacy's 302. */
function redirectBody(response: GatewayResponse<Buffer>, operation: string, relayed: RelayedCookies): RawBody {
  const { status, location } = response;
  if (location === undefined) {
    throw new TypeError(`${SERVICE} answered ${operation} with HTTP ${String(status)} but no Location`);
  }
  const headers = { ...REDIRECT_HEADERS, location };
  return { status, contentType: LEGACY_HTML_CONTENT_TYPE, body: '', headers, ...relayed };
}

/** `<cfinclude template="edit.cfm">` inside the layout: the rejected save's form with its errors, as a page. */
async function renderRejected(ctx: ScreenContext, result: WriteResult, relayed: RelayedCookies): Promise<RawBody> {
  const { req } = ctx;
  const view = await renderFeedEdit(req, ctx, feedEditModelFrom(result, req), { fuseaction: 'update' });
  const shell = await loadShellData(req, { gateway: ctx.gateway, csrf: ctx.csrf, rb: ctx.rb, now: ctx.now });
  const doc = renderAdminDocument(req, view, ctx.hooks, shell);
  return {
    contentType: LEGACY_HTML_CONTENT_TYPE,
    body: serializeAdminDocument(doc),
    ...(doc.noCache ? { headers: { ...NO_CACHE_HEADERS } } : {}),
    ...relayed,
  };
}

/**
 * `cFeed.update`: the service's FW/1 redirect to `cFeed.list` (a save, a delete or a refused token) as legacy's 302,
 * a rejected save re-rendered inside the layout, and any other answer (the close document) relayed byte for byte.
 * @throws GatewayDenialError When strategies-content answers 401 or 403.
 * @throws TypeError When a redirect has no `Location`, a body no `Content-Type`, or JSON is not a rejected save.
 */
export const cfeedUpdateScreen: FragmentScreen = Object.freeze({
  circuit: 'cfeed',
  action: 'update',
  mode: 'fragment',
  owner: SERVICE,
  gate: cfeedGate,
  async render(ctx: ScreenContext): Promise<RawBody> {
    // The defaulted request replaces `ctx.req`, so the re-rendered view and the shell read before()'s rc, and the
    // handler persists the session writes recorded on it.
    ctx.req = { ...ctx.req, rc: applyCfeedDefaults(ctx.req.rc) };
    const operation = `${ctx.body === undefined ? 'GET' : 'POST'} ${PATH}`;
    const response = await relay(ctx);
    assertNotDenied(response, SERVICE, operation);
    const relayed: RelayedCookies = response.setCookies.length > 0 ? { setCookies: [...response.setCookies] } : {};
    const { status } = response;
    if (status >= 300 && status < 400) return redirectBody(response, operation, relayed);
    const contentType = firstValue(response.headers['content-type']);
    if (contentType === undefined) throw new TypeError(`${SERVICE} answered ${operation} without a Content-Type`);
    if (response.ok && mediaTypeOf(contentType) === 'application/json') {
      const body = decodeServiceBody(response.body, contentType, SERVICE);
      return renderRejected(ctx, rejectedSave(body, operation), relayed);
    }
    return { status, contentType, body: response.body, ...relayed };
  },
});
