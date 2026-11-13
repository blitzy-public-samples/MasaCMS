// The carch screens' strategies-content calls through the gateway: page models, writes and raw relays (server-only).
import { isDeepStrictEqual } from 'node:util';
import { LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import type { components, paths } from '@/generated/clients/strategies-content';
import { secure, type GateDecision } from '@/lib/access-gate';
import {
  multipartRelay,
  okBody,
  type FormInput,
  type GatewayClient,
  type GatewayResponse,
  type MultipartBody,
  type MultipartRelay,
} from '@/lib/gateway-client';
import type { AdminRequest, AdminSessionWrites } from '@/lib/request-context';
import { boundAdminUrl } from '@/lib/urls';
import type { RawBody, Rc, ScreenContext, SubmitResult } from '../registry';

const SERVICE = 'strategies-content';

/** Headers a legacy form or ajax call may carry instead of its `csrf_token` fields. */
const CSRF_HEADERS = ['X-csrf_token', 'X-csrf_token_expires'] as const;

/** Service response headers a raw relay keeps; the handler adds the legacy base headers itself. */
const RELAYED_HEADERS = ['location', 'content-disposition', 'expires'] as const;

type Schemas = components['schemas'];
type Facade = GatewayClient['strategiesContent'];

/** Screen model a carch page operation returns. */
export type CarchPageModel = Schemas['AdminViewModel'];

/** Outcome a carch write operation returns. */
export type CarchWriteResult = Schemas['AdminWriteResult'];

/** The request and gateway a carch call needs. */
export type CarchCallContext = Pick<ScreenContext, 'req' | 'gateway'>;

/** The controller `secure()` redirect a strategies-content 401 or 403 answers with. */
export type CarchDenied = Extract<GateDecision, { readonly kind: 'redirect' }>;

/** A page or write call: its 2xx body, the `secure()` redirect of a denial, or any other 4xx as relayed. */
export type CarchOutcome<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | CarchDenied
  | { readonly kind: 'rejected'; readonly status: number; readonly body: unknown };

/** Options of {@link carchWrite} and {@link relayCarchRaw}. */
export interface CarchCallOptions {
  /** The action's effective FW/1 rc, carch defaults applied; `ctx.req.rc` when omitted. */
  readonly rc?: Rc;
  /** The inbound multipart body, posted unchanged in place of the rc fields (non-image uploads). */
  readonly multipart?: MultipartBody;
}

/** A facade answer: the contract's success body when `ok`, otherwise the body as relayed. */
type Answer<T> = (GatewayResponse<T> & { readonly ok: true }) | (GatewayResponse<unknown> & { readonly ok: false });

/** Body and headers of a POST. */
interface PostInput {
  readonly form?: FormInput;
  readonly body?: MultipartRelay['body'];
  readonly headers: Readonly<Record<string, string>>;
}

interface PageEntry {
  readonly operation: string;
  readonly call: (sc: Facade, rc: Rc) => Promise<Answer<CarchPageModel>>;
}

interface WriteEntry {
  readonly operation: string;
  readonly call: (sc: Facade, rc: Rc, input: PostInput) => Promise<Answer<CarchWriteResult>>;
}

// ---- rc reads ----

/** `rc[name]` by case-insensitive name, as a CFML scope reads it. */
function rcValue(rc: Rc, name: string): string | undefined {
  if (Object.hasOwn(rc, name)) return rc[name];
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/** `rc[name]`, failing as CFML does when the element is undefined. */
function required(rc: Rc, name: string): string {
  const value = rcValue(rc, name);
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in a CFML structure.`);
  return value;
}

/** `rc[name]` as a path segment; throws when empty, since an empty segment would address another operation. */
function segment(rc: Rc, name: string): string {
  const value = required(rc, name);
  if (value === '') throw new TypeError(`rc.${name} is empty; the strategies-content path needs a value`);
  return value;
}

/** The query parameters an operation declares, from the rc values present. */
function declared<N extends string>(rc: Rc, ...names: readonly N[]): Partial<Record<N, string>> {
  const query: Partial<Record<N, string>> = {};
  for (const name of names) {
    const value = rcValue(rc, name);
    if (value !== undefined) query[name] = value;
  }
  return query;
}

/** Every rc field, for a `RawParams` query or a form body; `omit` names are left out case-insensitively. */
function rcFields(rc: Rc, ...omit: readonly string[]): Record<string, string> {
  const left = new Set(omit.map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(rc).filter(([name]) => !left.has(name.toLowerCase())));
}

// ---- Operations ----

const siteOf = (rc: Rc): { siteid: string } => ({ siteid: segment(rc, 'siteid') });

/** Query parameters `getSiteManagerTree` declares; every other rc field travels in its `params`. */
const TREE_QUERY = ['topid', 'moduleid', 'sortBy', 'sortDirection', 'page'] as const;

const contentEditModel: PageEntry = {
  operation: 'getContentEditModel',
  call: (sc, rc) =>
    sc.call('get', '/v1/sites/{siteid}/content/{contentid}', {
      params: { ...siteOf(rc), contentid: segment(rc, 'contentid') },
      query: declared(rc, 'contenthistid', 'parentid', 'type', 'subtype', 'moduleid', 'title', 'compactDisplay'),
    }),
};

const contentVersionModel: PageEntry = {
  operation: 'getContentVersionModel',
  call: (sc, rc) =>
    sc.call('get', '/v1/sites/{siteid}/content/versions/{contenthistid}/summary', {
      params: { ...siteOf(rc), contenthistid: segment(rc, 'contenthistid') },
    }),
};

/** The page operation of each carch page action. */
const PAGE_CALLS = {
  list: {
    operation: 'getSiteManagerTree',
    call: (sc, rc) =>
      // The service runs the view's sort write and flat-view state over the whole rc, so the rest travels in params.
      sc.call('get', '/v1/sites/{siteid}/content/tree', {
        params: siteOf(rc),
        query: { ...declared(rc, ...TREE_QUERY), params: rcFields(rc, ...TREE_QUERY) },
      }),
  },
  search: {
    operation: 'listContent',
    call: (sc, rc) =>
      sc.call('get', '/v1/sites/{siteid}/content', {
        params: siteOf(rc),
        query: declared(rc, 'keywords', 'type', 'moduleid', 'page'),
      }),
  },
  draft: {
    operation: 'listDrafts',
    call: (sc, rc) => sc.call('get', '/v1/sites/{siteid}/content/drafts', { params: siteOf(rc) }),
  },
  selectmedia: {
    operation: 'getSelectMediaModel',
    call: (sc, rc) =>
      sc.call('get', '/v1/sites/{siteid}/content/images', { params: siteOf(rc), query: declared(rc, 'contentid') }),
  },
  edit: contentEditModel,
  editlive: contentEditModel,
  hist: {
    operation: 'getContentHistory',
    call: (sc, rc) =>
      sc.call('get', '/v1/sites/{siteid}/content/{contentid}/history', {
        params: { ...siteOf(rc), contentid: segment(rc, 'contentid') },
        query: declared(rc, 'startrow'),
      }),
  },
  audit: {
    operation: 'getContentVersionAudit',
    call: (sc, rc) =>
      sc.call('get', '/v1/sites/{siteid}/content/{contentid}/versions/{contenthistid}/audit', {
        params: { ...siteOf(rc), contentid: segment(rc, 'contentid'), contenthistid: segment(rc, 'contenthistid') },
      }),
  },
  multifileupload: {
    operation: 'getMultiFileUploadModel',
    // The upload screen adds children to `rc.parentid`; its `rc.contentid` is empty.
    call: (sc, rc) =>
      sc.call('get', '/v1/sites/{siteid}/content/{contentid}/multi-file-upload', {
        params: { ...siteOf(rc), contentid: segment(rc, 'parentid') },
      }),
  },
  lockcheck: contentVersionModel,
  relatedcontent: contentVersionModel,
  datamanager: {
    operation: 'listFormResponses',
    // The view's branch, edit row and filter read rc fields beyond the declared ones, so every field is sent.
    call: (sc, rc) =>
      sc.call('get', '/v1/sites/{siteid}/forms/{contentid}/responses', {
        params: { ...siteOf(rc), contentid: segment(rc, 'contentid') },
        query: { params: rcFields(rc) },
      }),
  },
  imagedetails: {
    operation: 'getImageDetailsModel',
    call: (sc, rc) =>
      sc.call('get', '/v1/sites/{siteid}/files/image-details', {
        params: siteOf(rc),
        query: declared(rc, 'fileid', 'contenthistid', 'userid', 'imagesize', 'compactDisplay'),
      }),
  },
  selectfields: {
    operation: 'getSelectFieldsModel',
    call: (sc, rc) =>
      sc.call('get', '/v1/sites/{siteid}/feeds/display-fields', { params: siteOf(rc), query: { params: rcFields(rc) } }),
  },
  variationtargeting: {
    operation: 'getVariationTargetingModel',
    call: (sc, rc) =>
      sc.call('get', '/v1/sites/{siteid}/variation-targeting', {
        params: siteOf(rc),
        query: { remoteid: required(rc, 'remoteid'), params: rcFields(rc, 'remoteid') },
      }),
  },
} satisfies Record<string, PageEntry>;

/** The write operation of each carch action that posts to one. */
const WRITE_CALLS = {
  updateobjectparams: {
    operation: 'updateObjectParams',
    call: (sc, rc, input) =>
      sc.call('post', '/v1/sites/{siteid}/content/versions/{contenthistid}/object-params', {
        params: { ...siteOf(rc), contenthistid: segment(rc, 'contenthistid') },
        ...input,
      }),
  },
  datamanager: {
    operation: 'deleteFormResponses',
    call: (sc, rc, input) =>
      sc.call('post', '/v1/sites/{siteid}/forms/{contentid}/responses/delete', {
        params: { ...siteOf(rc), contentid: segment(rc, 'contentid') },
        ...input,
      }),
  },
  variationtargeting: {
    operation: 'saveVariationTargeting',
    call: (sc, rc, input) => sc.call('post', '/v1/sites/{siteid}/variation-targeting', { params: siteOf(rc), ...input }),
  },
} satisfies Record<string, WriteEntry>;

/** Carch actions read through a strategies-content page operation. */
export type CarchPageAction = keyof typeof PAGE_CALLS;

/** Carch actions that write through a strategies-content admin write operation. */
export type CarchWriteAction = keyof typeof WRITE_CALLS;

/** Carch actions relayed through a `/v1/raw/carch/<action>` operation. */
export type CarchRawAction = {
  [P in keyof paths]: P extends `/v1/raw/carch/${infer Action}` ? Action : never;
}[keyof paths];

// ---- Request and response shapes ----

/** The CSRF headers the inbound request carried, unchanged. */
function csrfHeaders(req: AdminRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of CSRF_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

/** A POST of the rc fields URL-encoded, or of the multipart body as received. */
function postInput(req: AdminRequest, rc: Rc, multipart: MultipartBody | undefined): PostInput {
  const headers = csrfHeaders(req);
  if (multipart === undefined) return { form: Object.entries(rc), headers };
  const relay = multipartRelay(multipart);
  return { body: relay.body, headers: { ...headers, ...relay.headers } };
}

/** The controller `secure()` decision for `req`, which always redirects. */
function secureRedirect(req: AdminRequest): CarchDenied {
  const decision = secure(req);
  if (decision.kind === 'allow') throw new TypeError('secure() let a denied carch call through');
  return decision;
}

/** A page or write answer as its outcome; statuses outside 2xx and 4xx throw. */
function settle<T>(req: AdminRequest, operation: string, res: Answer<T>): CarchOutcome<T> {
  if (res.status === 401 || res.status === 403) return secureRedirect(req);
  if (!res.ok && res.status >= 400 && res.status < 500) return { kind: 'rejected', status: res.status, body: res.body };
  return { kind: 'ok', data: okBody(res, SERVICE, operation) };
}

const firstValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** A relayed answer as a bare body: status, content type, bytes and the relayed headers and cookies as received. */
function rawBodyOf(res: GatewayResponse<Buffer>): RawBody {
  const headers: Record<string, string> = {};
  for (const name of RELAYED_HEADERS) {
    const value = firstValue(res.headers[name]);
    if (value !== undefined) headers[name] = value;
  }
  return {
    status: res.status,
    // ACF labels every response, an aborted or redirecting action's included, with its HTML content type.
    contentType: firstValue(res.headers['content-type']) ?? LEGACY_HTML_CONTENT_TYPE,
    body: res.body,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(res.setCookies.length > 0 ? { setCookies: [...res.setCookies] } : {}),
  };
}

// ---- Calls ----

/**
 * The screen model of a carch page action, for `rc` (default `ctx.req.rc`) under its declared parameter names.
 * @throws TypeError When a path parameter (`siteid`, `contentid`, `contenthistid`; `parentid` for multifileupload) is empty.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 */
export async function carchPageData(
  ctx: CarchCallContext,
  action: CarchPageAction,
  rc: Rc = ctx.req.rc,
): Promise<CarchOutcome<CarchPageModel>> {
  const { operation, call } = PAGE_CALLS[action];
  return settle(ctx.req, operation, await call(ctx.gateway.strategiesContent, rc));
}

/**
 * Posts a carch write with every rc field (or the multipart body) and the CSRF headers unchanged.
 * @throws TypeError When a path parameter is empty.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 */
export async function carchWrite(
  ctx: CarchCallContext,
  action: CarchWriteAction,
  { rc = ctx.req.rc, multipart }: CarchCallOptions = {},
): Promise<CarchOutcome<CarchWriteResult>> {
  const { operation, call } = WRITE_CALLS[action];
  const input = postInput(ctx.req, rc, multipart);
  return settle(ctx.req, operation, await call(ctx.gateway.strategiesContent, rc, input));
}

/**
 * A post action's outcome for a write: its redirect, the denial's redirect, or `render` when it names none.
 * @throws Error For a `rejected` outcome, which the caller handles first where legacy answers it.
 */
export async function toSubmitResult(
  outcome: CarchOutcome<CarchWriteResult>,
  render: (result: CarchWriteResult) => SubmitResult | Promise<SubmitResult>,
): Promise<SubmitResult> {
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') throw new Error(`${SERVICE} rejected the carch write with HTTP ${outcome.status}`);
  const { redirect } = outcome.data;
  if (redirect === null) return render(outcome.data);
  // The contract hands over the redirect as `adminUrl` parts, already resolved, so no FW/1 append is redone here.
  return { kind: 'location', location: boundAdminUrl(redirect.circuit, redirect.action, redirect.params) };
}

/**
 * Relays a carch fragment, JSON or download action: GET sends the rc as url fields; POST sends `siteid` in the query and
 * the rc fields (or the multipart body) as the body. The answer's bytes are returned unchanged; a 401 or 403 becomes
 * the controller `secure()` redirect.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 */
export async function relayCarchRaw(
  ctx: CarchCallContext,
  action: CarchRawAction,
  method: 'GET' | 'POST',
  { rc = ctx.req.rc, multipart }: CarchCallOptions = {},
): Promise<RawBody> {
  const sc = ctx.gateway.strategiesContent;
  const path = `/v1/raw/carch/${action}` as const;
  // The effective rc, not the inbound query, is sent: the service renders from what legacy's controller sees, and the
  // screen context carries no raw query or body.
  const res =
    method === 'GET'
      ? await sc.raw('get', path, { query: { params: rcFields(rc) }, headers: csrfHeaders(ctx.req) })
      : await sc.raw('post', path, {
          query: declared(rc, 'siteid'),
          ...postInput(ctx.req, rc, multipart),
        });
  if (res.status === 401 || res.status === 403) {
    const { location } = secureRedirect(ctx.req);
    return { status: 302, contentType: LEGACY_HTML_CONTENT_TYPE, body: '', headers: { location } };
  }
  return rawBodyOf(res);
}

/** A raw relay as a post action's outcome: a 3xx with a `Location` redirects, anything else is emitted as received. */
export function rawSubmitResult(raw: RawBody): SubmitResult {
  const status = raw.status ?? 200;
  const location = raw.headers?.location;
  if (location !== undefined && status >= 300 && status < 400) return { kind: 'location', location };
  return { kind: 'raw', response: raw };
}

/** Sets each changed session value as legacy's `session.<key> = value`: on `req.session` and in the writes persisted. */
export function applySessionEffects(req: AdminRequest, effects: AdminSessionWrites): void {
  // Both are typed read-only for screens, but are this request's own objects, which the handler persists from.
  const session = req.session as unknown as Record<string, unknown>;
  const writes = req.sessionWrites as Record<string, unknown>;
  for (const [key, value] of Object.entries(effects)) {
    if (value === undefined || isDeepStrictEqual(session[key], value)) continue;
    session[key] = value;
    writes[key] = value;
  }
}
