/** `commentsProxy.cfc`: the data-only remote methods `get`, `flag` and `getContentStats`; `renderCommentsPage` renders CFML and stays legacy-served. */
import { AuthDenial, assertSiteMatches, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LEGACY_HTML_CONTENT_TYPE,
  cfIsBoolean,
  cfNumberString,
  cfToBoolean,
} from '@opt2/platform/legacy-compat';
import {
  legacyParamsOf,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { flagComment, getCommentValues, getContentStatsValues } from '../domain/comments.js';
import { actorFromClaims, type DomainDeps } from '../domain/context.js';
import { muraJsonEncode } from '../legacy/cfjson.js';

/** The route context these routes read: a structural subset of `ContentRouteContext`, so this module needs nothing from the `routes/index.ts` that registers it. */
export interface CommentsProxyRouteContext {
  domain: DomainDeps;
}

/** Path of the remote component; the container matches it case-sensitively. */
export const COMMENTS_PROXY_PATH = '/core/modules/v1/comments/ajax/commentsProxy.cfc';

// Public with no CSRF check, `flag` (a write) included, as legacy serves the component. The handler checks the effective
// `siteid` itself: a url value overrides a form value and a JSON body binds nothing, which the platform's check of every
// supplied `siteid` would not reproduce.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ public: true, transport: 'service', siteCheck: false });

type ServedMethod = 'get' | 'flag' | 'getcontentstats';

/** A served call with the arguments its method reads. */
interface BoundCall {
  method: ServedMethod;
  /** `commentID` of `get` and `flag`, `contentID` of `getContentStats`. */
  id: string;
  /** The `siteid` argument; undefined when the call binds none. */
  siteid: string | undefined;
}

/** The `cfargument` names of each served method (commentsProxy.cfc:88-112) and the one its body reads without a default. */
const METHODS: ReadonlyMap<string, { method: ServedMethod; idArgument: string; argumentNames: ReadonlySet<string> }> = new Map(
  (
    [
      ['get', 'commentid'],
      ['flag', 'commentid'],
      ['getcontentstats', 'contentid'],
    ] as const
  ).map(([method, idArgument]) => [method, { method, idArgument, argumentNames: new Set([idArgument, 'siteid']) }]),
);

/** Request fields ColdFusion's remote invocation consumes itself rather than binding them as method arguments. */
const INVOCATION_FIELDS: ReadonlySet<string> = new Set(['method', 'returnformat', 'queryformat', 'argumentcollection']);

/**
 * The ColdFusion error page legacy answers a call the component cannot run: an undefined method, an argument the method
 * does not declare, a missing argument its body reads, or an `argumentCollection` it cannot bind.
 */
const UNRUNNABLE_CALL = {
  status: 500,
  statusText: LEGACY_ERROR_STATUS_TEXT,
  headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE },
  body: LEGACY_ERROR_PAGE_HTML,
};

/** Raised while binding a call that legacy answers with {@link UNRUNNABLE_CALL}. */
class UnrunnableCall extends Error {
  override readonly name: string = 'UnrunnableCall';
}

/** One JSON `argumentCollection` member as ColdFusion binds it; undefined for null, which binds nothing. */
function collectionValue(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  throw new UnrunnableCall('Complex object types cannot be converted to simple values');
}

/** A JSON object `argumentCollection` as its bound members by lower-cased name, the last spelling winning; other text cannot bind. */
function collectionArguments(text: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UnrunnableCall('argumentCollection is not a JSON object');
  }
  const bound = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed)) {
    const member = collectionValue(value);
    if (member === undefined) bound.delete(name.toLowerCase());
    else bound.set(name.toLowerCase(), member);
  }
  return bound;
}

/** Whether the body is JSON, which ColdFusion never reads into the form scope. */
function hasJsonBody(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  return typeof contentType === 'string' && contentType.slice(0, 16).toLowerCase() === 'application/json';
}

/**
 * The request fields of a remote call by lower-cased name, as ColdFusion binds them: url values over form values over
 * the `argumentCollection` members, which never name the method. Repeated url keys join with `,`.
 */
function remoteFields(request: FastifyRequest): Map<string, string> {
  const fields = new Map<string, string>();
  const put = (name: string, value: unknown): void => {
    fields.set(name.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value));
  };
  if (!hasJsonBody(request)) {
    for (const [name, value] of Object.entries(legacyParamsOf(request))) put(name, value);
  }
  for (const [name, value] of Object.entries((request.query ?? {}) as Record<string, unknown>)) put(name, value);
  const collection = fields.get('argumentcollection');
  if (collection !== undefined) {
    for (const [name, value] of collectionArguments(collection)) {
      if (!fields.has(name) && !INVOCATION_FIELDS.has(name)) fields.set(name, value);
    }
  }
  return fields;
}

/** The served call a request names; throws {@link UnrunnableCall} where legacy cannot run it. */
function boundCall(request: FastifyRequest): BoundCall {
  const fields = remoteFields(request);
  const spec = METHODS.get((fields.get('method') ?? '').trim().toLowerCase());
  if (spec === undefined) throw new UnrunnableCall('The method is not served by this component');
  for (const name of fields.keys()) {
    if (!INVOCATION_FIELDS.has(name) && !name.startsWith('_') && !spec.argumentNames.has(name)) {
      throw new UnrunnableCall('The method does not support an argument the call binds');
    }
  }
  const id = fields.get(spec.idArgument);
  if (id === undefined) throw new UnrunnableCall('An argument the method reads is undefined');
  return { method: spec.method, id, siteid: fields.get('siteid') };
}

/** settingsBean.getScheme() without the site's `useSSL`, which this service does not hold: the request protocol (utility.cfc:481-500). */
export function requestScheme(request: FastifyRequest): 'http' | 'https' {
  const forwarded = request.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.toLowerCase() === 'https') return 'https';
  const frontEnd = request.headers['front-end-https'];
  if (typeof frontEnd === 'string' && cfIsBoolean(frontEnd) && cfToBoolean(frontEnd)) return 'https';
  return request.protocol === 'https' ? 'https' : 'http';
}

/** A `returnformat="plain"` remote result: the returned text as the body, as ACF writes it. */
function sendPlain(reply: FastifyReply, body: string): FastifyReply {
  return sendLegacyResponse(reply, { status: 200, headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE }, body });
}

/** Registers `GET` and `POST` of the comments proxy's data methods, served in the verified token's tenant. */
export function registerCommentsProxyRoutes(app: FastifyInstance, ctx: CommentsProxyRouteContext): void {
  const { domain } = ctx;

  app.route({
    method: ['GET', 'POST'],
    url: COMMENTS_PROXY_PATH,
    config: { opt2: ROUTE_AUTH },
    async handler(request, reply) {
      let call: BoundCall;
      try {
        call = boundCall(request);
      } catch (err) {
        if (err instanceof UnrunnableCall) return sendLegacyResponse(reply, UNRUNNABLE_CALL);
        throw err;
      }
      const claims = request.opt2Auth.user;
      if (claims === undefined) throw AuthDenial.unauthenticated('missing-credential');
      // Legacy defaults `siteid` to bindToDomain(), the site of the request host, which the gateway's token is minted for.
      const siteId = call.siteid ?? claims.site;
      assertSiteMatches(siteId, claims);
      switch (call.method) {
        case 'get': {
          // No commenter photo: the user photo is people's data, out of this service's reach, and legacy's join finds a user
          // only when a comment's commenter id is itself a user id (contentCommentBean.cfc:296-303), so FILEID stays ''.
          const values = await getCommentValues(domain, claims.tid, call.id, { scheme: requestScheme(request) });
          return sendPlain(reply, muraJsonEncode(values));
        }
        case 'flag':
          await flagComment(domain, claims.tid, call.id, { actor: actorFromClaims(claims, ''), requestId: request.id });
          return sendPlain(reply, '');
        case 'getcontentstats':
          return sendPlain(reply, muraJsonEncode(await getContentStatsValues(domain, claims.tid, call.id, siteId)));
      }
    },
  });
}
