// Inbound requests as the gateway forwards them to web, with platform-minted credentials, for handler and route tests.
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, type CsrfTokens } from '@opt2/platform/legacy-compat';
import { REQUEST_ID_HEADER } from '@opt2/platform/service-kit';
import { gatewayInvocation, userTokenFor, type WebTestSubject, type WebTestSubjectKey } from './tokens';

/** Fixed origin of every built request; web reads only its path and query. */
export const WEB_TEST_ORIGIN = 'http://web.test';

/** W3C trace context every built request carries unless overridden. */
export const TEST_TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

// Restated from the README's gateway ↔ web contract (item 3) rather than imported from web's own request context,
// so a request built here follows the contract even where web's reading of it is under test.
/** Header in which the gateway passes the browser's request target. */
const ORIGINAL_URL_HEADER = 'x-opt2-original-url';

/** Forwarding headers the gateway always adds (contract item 4): the browser's host, scheme and address. */
const FORWARDED_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-forwarded-host': 'localhost',
  'x-forwarded-proto': 'http',
  'x-forwarded-for': '127.0.0.1',
});

/** Web path prefixes of the legacy admin response modes, whose requests carry the original-URL header. */
const ADMIN_PREFIXES = ['/admin/', '/admin-actions/', '/admin-raw/'] as const;

/** Legacy admin entry the browser URL defaults to. */
const LEGACY_ADMIN_PATH = '/admin/';

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const JSON_CONTENT_TYPE = 'application/json';

/** A multipart file part: file name, media type and content. */
export interface MultipartFile {
  readonly name: string;
  readonly type: string;
  readonly data: Uint8Array | string;
}

/** What one gateway-forwarded request carries; at most one of `form`, `multipart` and `json`. */
export interface AdminRequestOptions {
  /** Defaults to `POST` with a body, else `GET`. */
  method?: string;
  /** Query pairs in caller order; an array repeats its key. */
  query?: Record<string, string | string[]>;
  /** Url-encoded body pairs; an array repeats its key. */
  form?: Record<string, string | string[]>;
  multipart?: Record<string, string | Blob | MultipartFile>;
  json?: unknown;
  /** Subject whose minted user token goes in `Authorization`; none for `anonymous`. */
  user?: WebTestSubject | WebTestSubjectKey;
  /** Raw user token, taking precedence over `user`. */
  userToken?: string;
  /** Set last, replacing any header built here. */
  headers?: Record<string, string>;
  /** Raw invocation token (default: the gateway's); `false` omits the header. */
  invocation?: string | false;
  /** Browser request target; when given, the web query is the caller's alone. */
  originalUrl?: string;
  requestId?: string;
}

let requestCount = 0;

/** Restarts the default `x-request-id` sequence at `test-request-1`. */
export function resetRequestIds(): void {
  requestCount = 0;
}

/** Joins two query strings with `&`, skipping an empty one. */
function joinQuery(first: string, second: string): string {
  return first !== '' && second !== '' ? `${first}&${second}` : first || second;
}

/** Url-encoded pairs of `record` in its key order, an array value repeating its key. */
function searchParamsOf(record: Record<string, string | string[]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(record)) {
    for (const item of typeof value === 'string' ? [value] : value) params.append(name, item);
  }
  return params;
}

/** `<circuit>.<action>` of a legacy admin web path; undefined for any other path. */
function adminActionOf(pathname: string): string | undefined {
  const prefix = ADMIN_PREFIXES.find((candidate) => pathname.startsWith(candidate));
  if (prefix === undefined) return undefined;
  const [circuit, action, ...rest] = pathname.slice(prefix.length).split('/');
  if (!circuit || !action || rest.length > 0) {
    throw new TypeError(`Not a ${prefix}<circuit>/<action> path: ${pathname}`);
  }
  return `${decodeURIComponent(circuit)}.${decodeURIComponent(action)}`;
}

/** Whether `query` names the FW/1 action itself, as `muraAction` or `fuseaction` in any case. */
function namesAction(query: string): boolean {
  return [...new URLSearchParams(query).keys()].some((name) => /^(muraaction|fuseaction)$/i.test(name));
}

/**
 * Web query and original-URL header of a request. Like the gateway, an admin path's web query is the browser query
 * verbatim: the caller's, led by `muraAction=<circuit>.<action>` unless it names the action itself.
 */
function targetOf(
  pathname: string,
  query: string,
  originalUrl: string | undefined,
): { query: string; originalUrl?: string } {
  if (originalUrl !== undefined) return { query, originalUrl };
  const action = adminActionOf(pathname);
  if (action === undefined) return { query };
  const legacyQuery = namesAction(query) ? query : joinQuery(`muraAction=${encodeURIComponent(action)}`, query);
  return { query: legacyQuery, originalUrl: `${LEGACY_ADMIN_PATH}?${legacyQuery}` };
}

/** Multipart body of `parts`; `Request` sets its boundary. */
function formDataOf(parts: Record<string, string | Blob | MultipartFile>): FormData {
  const data = new FormData();
  for (const [field, value] of Object.entries(parts)) {
    if (typeof value === 'string' || value instanceof Blob) {
      data.append(field, value);
    } else {
      const content = typeof value.data === 'string' ? value.data : new Uint8Array(value.data);
      data.append(field, new File([content], value.name, { type: value.type }));
    }
  }
  return data;
}

/** Body and content type of the one body option given. */
function bodyOf({ form, multipart, json }: AdminRequestOptions): { body?: BodyInit; contentType?: string } {
  if ([form, multipart, json].filter((part) => part !== undefined).length > 1) {
    throw new TypeError('Give at most one of form, multipart and json');
  }
  if (form !== undefined) return { body: searchParamsOf(form), contentType: FORM_CONTENT_TYPE };
  if (multipart !== undefined) return { body: formDataOf(multipart) };
  if (json !== undefined) return { body: JSON.stringify(json), contentType: JSON_CONTENT_TYPE };
  return {};
}

/**
 * A request for web `path` (`/admin/<circuit>/<action>`, `/admin-actions/…`, `/admin-raw/…`, `/opt2/admin/…`,
 * `/opt2/admin-actions/…`, optionally with a query), carrying the gateway's invocation credential, the user token,
 * the original-URL header on legacy admin paths, `x-request-id`, `traceparent` and the forwarding headers.
 */
export async function adminRequest(path: string, opts: AdminRequestOptions = {}): Promise<Request> {
  const queryAt = path.indexOf('?');
  const pathname = queryAt < 0 ? path : path.slice(0, queryAt);
  const inlineQuery = queryAt < 0 ? '' : path.slice(queryAt + 1);
  const callerQuery = joinQuery(inlineQuery, searchParamsOf(opts.query ?? {}).toString());
  const target = targetOf(pathname, callerQuery, opts.originalUrl);
  const { body, contentType } = bodyOf(opts);

  const headers = new Headers({ ...FORWARDED_HEADERS, traceparent: TEST_TRACEPARENT });
  headers.set(REQUEST_ID_HEADER, opts.requestId ?? `test-request-${++requestCount}`);
  if (opts.invocation !== false) {
    headers.set(INVOCATION_HEADER, `Bearer ${opts.invocation ?? (await gatewayInvocation())}`);
  }
  const userToken = opts.userToken ?? (opts.user === undefined ? undefined : await userTokenFor(opts.user));
  if (userToken !== undefined) headers.set('authorization', `Bearer ${userToken}`);
  if (target.originalUrl !== undefined) headers.set(ORIGINAL_URL_HEADER, target.originalUrl);
  if (contentType !== undefined) headers.set('content-type', contentType);
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);

  const url = `${WEB_TEST_ORIGIN}${pathname}${target.query === '' ? '' : `?${target.query}`}`;
  return new Request(url, { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
}

/** `fields` with the legacy CSRF form fields of `tokens` added. */
export function formWithCsrf(fields: Record<string, string>, tokens: CsrfTokens): Record<string, string> {
  return { ...fields, [CSRF_FIELD_TOKEN]: tokens.token, [CSRF_FIELD_EXPIRES]: tokens.expires };
}

/** Second argument of a Next 16 route handler or page: its params as a promise. */
export function routeParams<T extends Record<string, string>>(obj: T): { params: Promise<T> } {
  return { params: Promise.resolve(obj) };
}
