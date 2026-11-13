// The `cArch.update` action: a content save, delete or upload relayed to strategies-content and answered as
// carch/update.cfm answers it (server-only).
import { LEGACY_HTML_CONTENT_TYPE, cfToBoolean } from '@opt2/platform/legacy-compat';
import { decodeServiceBody } from '@opt2/platform/service-kit';
import { isCompactDisplay } from '@/lib/cfml';
import { assignContext, setSessionMuraValue } from '@/lib/request-context';
import { NO_CACHE_HEADERS, REDIRECT_HEADERS } from '@/lib/responses';
import { loadShellData, renderAdminDocument, serializeAdminDocument } from '@/shell/document';
import type { FragmentScreen, RawBody, Rc, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { renderEditView } from './edit';
import { structOf, structText, structValue, type CarchStruct } from './model';
import {
  closeCompactDisplay,
  type CloseCompactContent,
  type CloseCompactDisplayModel,
  type CloseCompactEdited,
} from './partials/close-compact-display';
import { relayCarchRaw, type CarchWriteResult } from './service';

const SERVICE = 'strategies-content';

/** `session.mura` key of the bean a rejected save keeps for the extended attributes it re-opens. */
const EDIT_BEAN_SESSION_KEY = 'editBean';

/** Service `Set-Cookie` values a rendered answer relays unchanged. */
type RelayedCookies = Pick<RawBody, 'setCookies'>;

/** Lower-cased media type of a `Content-Type` value. */
const mediaTypeOf = (contentType: string): string => (contentType.split(';')[0] ?? '').trim().toLowerCase();

/** `struct[key]` as CFML text; throws when strategies-content left it out. */
function textOf(struct: CarchStruct, key: string): string {
  if (structValue(struct, key) === undefined) throw new TypeError(`${SERVICE} returned no ${key} for carch.update`);
  return structText(struct, key);
}

/** `struct[key]` as a CFML boolean; throws when it is absent or not a boolean. */
const flagOf = (struct: CarchStruct, key: string): boolean => cfToBoolean(structValue(struct, key));

/** `rc[name]`, failing with ACF's message when the view reads an undefined element. */
function rcText(rc: Rc, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** The service's answer for the request as before() leaves it: a multipart post as received, else the rc fields. */
function relay(ctx: ScreenContext): Promise<RawBody> {
  const { body } = ctx;
  // AdminRequest carries no method; only a POST carries a body. The CSRF pair travels as it came, never checked here.
  if (body === undefined) return relayCarchRaw(ctx, 'update', 'GET');
  return relayCarchRaw(ctx, 'update', 'POST', body.form instanceof FormData ? { multipart: body } : {});
}

/** A save the view renders, as the contract's JSON answer carries it. */
type UnabortedSave = CarchWriteResult & { readonly redirect: null; readonly data: CarchStruct };

const isStruct = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUnabortedSave = (value: unknown): value is UnabortedSave =>
  isStruct(value) && value.redirect === null && isStruct(value.errors) && isStruct(value.data);

/** The JSON answer as the contract's unaborted save; anything else is a contract breach. */
function unabortedSaveOf(raw: RawBody): UnabortedSave {
  const { body } = raw;
  const bytes = body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : undefined;
  const result = bytes === undefined ? undefined : decodeServiceBody(bytes, raw.contentType, SERVICE);
  if (!isUnabortedSave(result)) {
    throw new TypeError(`${SERVICE} answered carch.update with JSON that is not an unaborted save`);
  }
  return result;
}

/** The FW/1 or `cflocation` redirect the service took, with the headers and empty body of legacy's 302. */
function redirectBody(raw: RawBody, status: number, relayed: RelayedCookies): RawBody {
  const location = raw.headers?.location;
  if (location === undefined) {
    throw new TypeError(`${SERVICE} answered carch.update with HTTP ${String(status)} but no Location`);
  }
  const headers = { ...REDIRECT_HEADERS, location };
  return { status, contentType: LEGACY_HTML_CONTENT_TYPE, body: '', headers, ...relayed };
}

/** Lines 98-335: a rejected save's editor inside the layout, its bean kept as `session.mura.editBean`. */
async function renderRejected(ctx: ScreenContext, data: CarchStruct, relayed: RelayedCookies): Promise<RawBody> {
  const bean = structOf(data, 'contentBean');
  const { rc } = ctx.req;
  ctx.req = {
    ...ctx.req,
    rc: assignContext(rc, {
      ...(isCompactDisplay(rc.closeCompactDisplay) ? { compactDisplay: 'true' } : {}),
      contentHistID: structText(bean, 'contentHistID'),
      contentID: structText(bean, 'contentID'),
    }),
  };
  setSessionMuraValue(ctx.req, EDIT_BEAN_SESSION_KEY, bean);
  const view = await renderEditView(ctx, { rc: data });
  // The editor's own rc changes stand on `ctx.req`, which the layout then reads.
  const { req } = ctx;
  const shell = await loadShellData(req, { gateway: ctx.gateway, csrf: ctx.csrf, rb: ctx.rb, now: ctx.now });
  const doc = renderAdminDocument(req, view, ctx.hooks, shell);
  return {
    contentType: LEGACY_HTML_CONTENT_TYPE,
    body: serializeAdminDocument(doc),
    ...(doc.noCache ? { headers: { ...NO_CACHE_HEADERS } } : {}),
    ...relayed,
  };
}

/** A content bean of the close data with the URLs strategies-content computed for it. */
function contentOf(bean: CarchStruct): CloseCompactContent {
  return {
    active: flagOf(bean, 'active'),
    isOnDisplay: flagOf(bean, 'isOnDisplay'),
    type: textOf(bean, 'type'),
    contentId: textOf(bean, 'contentID'),
    contentHistId: textOf(bean, 'contentHistID'),
    url: textOf(bean, 'url'),
    previewUrl: textOf(bean, 'previewURL'),
  };
}

/** `data[key]` as a struct, or undefined when the save's branch reads no such bean. */
function optionalBean(data: CarchStruct, key: string): CarchStruct | undefined {
  return structValue(data, key) === undefined ? undefined : structOf(data, key);
}

/** dsp_close_compact_display.cfm's inputs: the request's rc and the beans the service read for the save's branch. */
function closeModel(rc: Rc, data: CarchStruct): CloseCompactDisplayModel {
  const saved = structOf(data, 'contentBean');
  const edited: CloseCompactEdited = {
    type: textOf(saved, 'type'),
    contentId: textOf(saved, 'contentID'),
    remoteUrl: structText(saved, 'remoteURL'),
    active: flagOf(saved, 'active'),
  };
  const homeId = rcText(rc, 'homeID');
  const parentHistId = rc.parenthistid ?? '';
  const current = optionalBean(data, 'currentBean');
  const parent = optionalBean(data, 'parentBean');
  const fallback = optionalBean(data, 'parentContentBean');
  return {
    action: rcText(rc, 'action'),
    homeId,
    homeUrl: homeId === '' ? '' : textOf(data, 'homeURL'),
    preview: rcText(rc, 'preview'),
    parentHistId,
    edited,
    ...(current === undefined
      ? {}
      : { current: { ...contentOf(current), previewUrlForEdited: textOf(current, 'editedPreviewURL') } }),
    // The parent's `rc.parenthistid` preview is read only when the request names one.
    ...(parent === undefined
      ? {}
      : {
          parent: {
            ...contentOf(parent),
            previewUrlForParentHistId: parentHistId === '' ? '' : textOf(parent, 'parentHistPreviewURL'),
            parentHistIdExists: parentHistId !== '' && flagOf(parent, 'parentHistExists'),
          },
        }),
    ...(fallback === undefined ? {} : { fallback: contentOf(fallback) }),
    useLayoutManager: flagOf(data, 'useLayoutManager'),
  };
}

/** Lines 336-338: the compact-display close document, after `session.mura.editBean` is deleted. */
function renderClose(ctx: ScreenContext, data: CarchStruct, relayed: RelayedCookies): RawBody {
  setSessionMuraValue(ctx.req, EDIT_BEAN_SESSION_KEY, undefined);
  const body = closeCompactDisplay(ctx, closeModel(ctx.req.rc, data));
  return { contentType: LEGACY_HTML_CONTENT_TYPE, body, ...relayed };
}

/**
 * `cArch.update`: carch before(), then strategies-content's save, delete or upload. Its redirect is legacy's 302, a
 * JSON answer is the save the view renders (a rejected save's editor in the layout, else the close document), and any
 * other answer (the aborted upload and ajax bodies) is relayed byte for byte. The session values the service reports
 * set are applied by the relay.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 * @throws TypeError When a redirect has no `Location`, or the JSON or its data are not what the contract names.
 */
export const updateScreen: FragmentScreen = Object.freeze({
  circuit: 'carch',
  action: 'update',
  mode: 'fragment',
  owner: CARCH_OWNER,
  gate: carchGate,
  secondaryMenu: 'carch',
  async render(ctx: ScreenContext): Promise<RawBody> {
    // before() runs ahead of the action; the handler persists its session writes from the request left on `ctx`.
    ctx.req = applyCarchDefaults(ctx.req);
    const raw = await relay(ctx);
    const status = raw.status ?? 200;
    const relayed: RelayedCookies = raw.setCookies === undefined ? {} : { setCookies: raw.setCookies };
    if (status >= 300 && status < 400) return redirectBody(raw, status, relayed);
    if (status !== 200 || mediaTypeOf(raw.contentType) !== 'application/json') return raw;
    const { errors, data } = unabortedSaveOf(raw);
    // `not structIsEmpty(rc.contentBean.getErrors())` picks the view's branch.
    if (Object.keys(errors).length > 0) return renderRejected(ctx, data, relayed);
    return renderClose(ctx, data, relayed);
  },
});
