/** Masa's favorites templates `saveFavorite.cfm`, `deleteFavorite.cfm` and `deleteRSSFavorite.cfm`, under every method legacy runs them for. */
import type { Opt2RouteConfig } from '@opt2/platform/auth';
import { LEGACY_ERROR_PAGE_HTML, LEGACY_ERROR_STATUS_TEXT, LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import {
  defaultSurfaceOf,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type LegacySurface,
} from '@opt2/platform/service-kit';
import {
  FavoriteTemplateError,
  deleteFavorite,
  deleteRssFavorites,
  saveFavorite,
  urlFieldsOf,
  type FavoriteDeps,
} from '../domain/favorites.js';

/** Folder of the templates; the container matches it case-sensitively. */
export const FAVORITES_PATH = '/core/modules/v1/favorites/ajax';

const FAVORITES_FOLDER = `${FAVORITES_PATH.toLowerCase()}/`;

/** A `%` without two hex digits after it, which the servlet container refuses anywhere in a query string. */
const MALFORMED_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

/** A character the servlet container refuses anywhere in a request target: one outside printable ASCII, or one of `` "#<>\^`{|} ``. */
const REFUSED_CHARACTER = /[^\x21-\x7e]|["#<>\\^`{|}]/;

/** Whether the servlet container refuses the raw request target `target` before ColdFusion runs. */
export function containerRefuses(target: string): boolean {
  const query = target.indexOf('?');
  return REFUSED_CHARACTER.test(target) || (query >= 0 && MALFORMED_ESCAPE.test(target.slice(query + 1)));
}

/** The path of `request`, percent escapes decoded as the router decodes them. */
function decodedPathOf(request: FastifyRequest): string {
  return decodeURI(request.url.split('?', 1)[0] ?? '');
}

/** Whether the decoded path of `request` lies in the templates' folder, in any letter case. */
function inFavoritesFolder(request: FastifyRequest): boolean {
  return decodedPathOf(request).toLowerCase().startsWith(FAVORITES_FOLDER);
}

/** A `.cfm` or `.cfc` name, its extension in any letter case; legacy answers a missing one at 404 whatever the start-up scan finds. */
const TEMPLATE_NAME = /\.cf[cm]$/i;

/** The error surface of a request: the ColdFusion error page for a path in the templates' folder; the platform default elsewhere. */
export function favoritesSurfaceOf(request: FastifyRequest): LegacySurface {
  return inFavoritesFolder(request) ? 'admin' : defaultSurfaceOf(request);
}

/** createService's `containerRefusesTarget`: whether the container refuses the target of a path in the templates' folder, in any letter case. */
export function favoritesTargetRefused(request: FastifyRequest): boolean {
  return containerRefuses(request.url) && inFavoritesFolder(request);
}

/** createService's `skipsStartupScan`: whether a path in the templates' folder, in any letter case, names a template no route serves, so its 404 stands. */
export function favoritesTemplateMissing(request: FastifyRequest): boolean {
  return request.routeOptions.url === undefined && inFavoritesFolder(request) && TEMPLATE_NAME.test(decodedPathOf(request));
}

// Public with no CSRF check and no site check, as legacy runs the templates for anonymous callers; they read url fields only.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ public: true, transport: 'service', siteCheck: false });

/** The methods the contract declares; legacy runs the templates alike for each, HEAD included. */
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const;

/** The ColdFusion error page legacy answers a failed template with. */
const ERROR_PAGE = {
  status: 500,
  statusText: LEGACY_ERROR_STATUS_TEXT,
  headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE },
  body: LEGACY_ERROR_PAGE_HTML,
};

type Template = (deps: FavoriteDeps, url: ReadonlyMap<string, string>, write: WriteContext) => Promise<string>;

/** A HEAD answer keeps the template's status and headers and sends no body or length, as legacy's chunked answer does. */
function headersOnly(request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err: null, payload: unknown) => void): void {
  if (request.method !== 'HEAD') {
    done(null, payload);
    return;
  }
  reply.removeHeader('content-length');
  done(null, null);
}

const TEMPLATES: readonly (readonly [string, Template])[] = [
  ['saveFavorite.cfm', saveFavorite],
  ['deleteFavorite.cfm', deleteFavorite],
  ['deleteRSSFavorite.cfm', deleteRssFavorites],
];

/** Registers each favorites template for every contract method; the app's createService takes {@link favoritesTargetRefused} and {@link favoritesTemplateMissing}. */
export function registerFavoriteRoutes(app: FastifyInstance, deps: FavoriteDeps): void {
  for (const [file, template] of TEMPLATES) {
    app.route({
      method: [...METHODS],
      url: `${FAVORITES_PATH}/${file}`,
      config: { opt2: ROUTE_AUTH },
      onSend: headersOnly,
      async handler(request: FastifyRequest, reply: FastifyReply) {
        let body: string;
        try {
          body = await template(deps, urlFieldsOf(request.url), { origin: 'target', requestId: request.id });
        } catch (err) {
          if (err instanceof FavoriteTemplateError) return sendLegacyResponse(reply, ERROR_PAGE);
          throw err;
        }
        return sendLegacyResponse(reply, { status: 200, headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE }, body });
      },
    });
  }
}
