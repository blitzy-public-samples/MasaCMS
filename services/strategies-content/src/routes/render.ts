/** `/_api/render/*` and `/tasks/render/*`: stored files and renditions streamed as legacy streams them (contentServer.cfc:655-668), never through a signed URL. */
import { AuthDenial, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LEGACY_HTML_CONTENT_TYPE,
  LegacyServiceUnavailableError,
  isCfUuid,
} from '@opt2/platform/legacy-compat';
import { recordOutcomeReason, sendLegacyResponse, type FastifyInstance, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import { StorageObjectNotFoundError, sendLegacyFile, type StoragePort } from '@opt2/platform/storage';
import type { DomainDeps } from '../domain/context.js';
import { resolveRenderObject, type RenderDeps } from '../domain/files.js';
import { CONTENT_FILES_BUCKET } from '../migration/objects.js';

/** The route context these routes read: a structural subset of `ContentRouteContext`, so this module needs nothing from the `routes/index.ts` that registers it. */
export interface RenderRouteContext {
  domain: Pick<DomainDeps, 'db' | 'repository'>;
  storage: StoragePort;
}

/** The fileManager function a request reaches: renderFile, renderSmall or renderMedium. */
export type RenderKind = 'file' | 'small' | 'medium';

/** A render request as handleAPIRequest reads it, or `matched: false` when its render branch is not taken. */
export type ParsedRenderRequest =
  | { matched: false }
  | {
      matched: true;
      kind: RenderKind;
      /** `url.fileid`. */
      fileId: string;
      /** Content-Disposition type: `url.method` for renderFile ('' read as `inline`); always `inline` for renderSmall and renderMedium. */
      method: string;
      /** `url.size`, else the third path segment. */
      size: string;
    };

/** A request's query as Fastify parses it: a repeated key holds an array. */
export type RenderQuery = Readonly<Record<string, string | readonly string[] | undefined>>;

type RenderRoute = { Params: { size: string }; Querystring: RenderQuery };

/** handleAPIRequest's file endpoints, compared without case as CFML `eq` compares (contentServer.cfc:599, 606). */
const RENDER_PREFIXES = ['/_api/render/', '/tasks/render/'] as const;

const ROUTE: { opt2: Opt2RouteConfig } = Object.freeze({ opt2: Object.freeze({ public: true, transport: 'service' }) });

/** handleAPIRequest falling through every endpoint: an empty page. */
const UNMATCHED = Object.freeze({ status: 200, headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE }, body: '' });

// The body of render404 is the site theme's 404 page, which only the CFML runtime renders; status, reason and type are legacy's.
/** contentServer.render404 (contentServer.cfc:505-510). */
const NOT_FOUND = Object.freeze({ status: 404, statusText: 'Content Not Found', headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE }, body: '' });

/** Legacy onError's page, which answers streamFile's FileOpen of a missing file (fileManager.cfc:933). */
const ERROR_PAGE = Object.freeze({
  status: 500,
  statusText: LEGACY_ERROR_STATUS_TEXT,
  headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE },
  body: LEGACY_ERROR_PAGE_HTML,
});

/** CFML url scope: keys ignore case, a repeated key's values are joined with `,`. */
function urlScope(query: RenderQuery): Map<string, string> {
  const scope = new Map<string, string>();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) scope.set(key.toLowerCase(), typeof value === 'string' ? value : value.join(','));
  }
  return scope;
}

/**
 * The render branch of handleAPIRequest for `path` (cgi.path_info) and the url scope only, as legacy reads no form field here.
 * @throws RangeError for a matched path without a third segment: cfparam evaluates its `listGetAt(path,3,'/')` default eagerly.
 */
export function renderRequestOf(path: string, query: RenderQuery): ParsedRenderRequest {
  const url = urlScope(query);
  const fileId = url.get('fileid');
  // CFML list functions skip empty segments.
  const segments = path.split('/').filter((segment) => segment !== '');
  const lowerPath = path.toLowerCase();
  if (fileId === undefined || segments.length < 2 || !RENDER_PREFIXES.some((prefix) => lowerPath.startsWith(prefix))) {
    return { matched: false };
  }
  const third = segments[2];
  if (third === undefined) throw new RangeError(`listGetAt: ${path} has no third segment`);
  const size = url.get('size') ?? third;
  // cfswitch matches without case; renderSmall and renderMedium take no method, so theirs is the `inline` default.
  const named = size.toLowerCase();
  if (named === 'small' || named === 'medium') return { matched: true, kind: named, fileId, method: 'inline', size };
  const method = url.get('method') ?? '';
  return { matched: true, kind: 'file', fileId, method: method === '' ? 'inline' : method, size };
}

/** Answers one render request: the stored bytes, or the legacy page its outcome takes. */
async function render(deps: RenderDeps, prefix: string, request: FastifyRequest<RenderRoute>, reply: FastifyReply): Promise<FastifyReply> {
  const req = renderRequestOf(`${prefix}${request.params.size}`, request.query);
  if (!req.matched) return sendLegacyResponse(reply, UNMATCHED);
  // render404 runs before any read (fileManager.cfc:210, 280, 322), so these need no tenant and therefore no credential.
  if (!isCfUuid(req.fileId) || (req.kind === 'file' && req.size.includes('.'))) return sendLegacyResponse(reply, NOT_FOUND);

  const claims = request.opt2Auth.user;
  if (claims === undefined) throw AuthDenial.unauthenticated('missing-credential');
  const found = await resolveRenderObject(deps, { tenantId: claims.tid, fileId: req.fileId, size: req.size });
  if (found.kind === 'not-found') return sendLegacyResponse(reply, NOT_FOUND);
  // Legacy generates a missing sized rendition with ColdFusion's image engine (cropAndScale), whose bytes no other encoder
  // reproduces (EX-FILE-RENDITION); the route fails closed rather than serve different bytes or a 404 legacy never sends.
  if (found.kind === 'missing-rendition') {
    throw new LegacyServiceUnavailableError(`Rendition ${found.objectKey} was never stored`, 'auto', 'missing-rendition');
  }

  try {
    return await sendLegacyFile(reply, {
      storage: deps.storage,
      bucket: CONTENT_FILES_BUCKET,
      key: found.objectKey,
      contentType: found.contentType,
      fileName: found.fileName,
      method: req.method,
      lastModified: found.created ?? undefined,
    });
  } catch (err) {
    // A `tfiles` row whose object is absent, such as `_small` of a non-image file, fails streamFile in legacy too.
    if (!(err instanceof StorageObjectNotFoundError)) throw err;
    recordOutcomeReason(request, 'stored-object-missing');
    return sendLegacyResponse(reply, ERROR_PAGE);
  }
}

/** Registers `renderGet` and `tasksRenderGet`; legacy authenticates neither. */
export function registerRenderRoutes(app: FastifyInstance, ctx: RenderRouteContext): void {
  const deps: RenderDeps = { db: ctx.domain.db, repository: ctx.domain.repository, storage: ctx.storage };
  for (const prefix of RENDER_PREFIXES) {
    app.get<RenderRoute>(`${prefix}:size`, { config: ROUTE }, (request, reply) => render(deps, prefix, request, reply));
  }
}
