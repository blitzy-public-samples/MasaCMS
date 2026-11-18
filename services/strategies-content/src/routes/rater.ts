/** `rater/ajax/saveRate.cfm`: saves the posted rating and answers the item's average rating as Mura.json encodes it. */
import { AuthDenial, assertSiteMatches, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  LEGACY_HTML_CONTENT_TYPE,
  LegacyFaultError,
  javaTrim,
  legacyDebuggingEnabled,
  legacyRuntimeErrorResponse,
} from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { legacyScopesOf, sendLegacyResponse, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { actorFromClaims, writeContextFor, type DomainDeps } from '../domain/context.js';
import { saveRate, storedRate } from '../domain/stats.js';
import { esapiEncode } from '../legacy/admin-markup.js';
import { muraJsonEncode } from '../legacy/cfjson.js';

/** The route context this route reads: a structural subset of `ContentRouteContext`. */
export interface RaterRouteContext {
  domain: DomainDeps;
}

/** Path of the rater's save template; the container matches it case-sensitively. */
export const RATER_SAVE_PATH = '/core/modules/v1/rater/ajax/saveRate.cfm';

// Public with no CSRF check, as legacy serves the template; the handler checks the form's `siteID` itself, since the
// platform's check would also read the url scope, which the template ignores.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ public: true, transport: 'service', siteCheck: false });

/** The getAvgRating query's columns. */
const AVG_RATING_COLUMNS: readonly string[] = Object.freeze(['DOWNVOTES', 'THEAVG', 'THECOUNT', 'UPVOTES']);

/** The form fields the template passes to raterManager.saveRate, in its order (saveRate.cfm:78-82). */
const RATE_FORM_FIELDS: readonly string[] = Object.freeze(['contentID', 'siteID', 'userID', 'rate']);

/** Widths of the `tcontentratings` key columns: contentID and userID char(35), siteID char(25). */
const ID_LENGTH = 35;
const SITE_ID_LENGTH = 25;

/** Whether a trimmed id can be inserted into a key column of `width` characters: neither empty (NULL) nor longer. */
function fitsKeyColumn(id: string, width: number): boolean {
  return id !== '' && id.length <= width;
}

/** The form fields the template passes to raterManager.saveRate, with the rate as SQL Server stores it. */
interface RateFields {
  contentId: string;
  siteId: string;
  userId: string;
  rate: number;
}

/**
 * The template's `form.contentID`, `form.siteID`, `form.userID` and `form.rate`, read ignoring case. Where legacy fails the
 * save: the fault of the first missing field, read in that order; undefined for an engine error, a rate {@link storedRate}
 * refuses or a trimmed id that is empty, which the rating insert binds as NULL, or longer than its key column, which SQL
 * Server refuses.
 */
function rateFields(request: FastifyRequest): RateFields | LegacyFaultError | undefined {
  const form = new Map(legacyScopesOf(request).form.entries.map(([name, value]) => [name.toLowerCase(), String(value)]));
  const missing = RATE_FORM_FIELDS.find((name) => !form.has(name.toLowerCase()));
  if (missing !== undefined) return new LegacyFaultError(`Element ${missing.toUpperCase()} is undefined in FORM.`);
  const [contentId = '', siteId = '', userId = '', rateText = ''] = RATE_FORM_FIELDS.map((name) => form.get(name.toLowerCase()));
  const rate = storedRate(rateText);
  const keys: ReadonlyArray<readonly [string, number]> = [[contentId, ID_LENGTH], [siteId, SITE_ID_LENGTH], [userId, ID_LENGTH]];
  if (rate === undefined || keys.some(([id, width]) => !fitsKeyColumn(javaTrim(id), width))) return undefined;
  return { contentId, siteId, userId, rate };
}

/**
 * Registers `GET` and `POST` of the rater's save, as the template answers any method, written in the verified token's tenant.
 * @param debuggingEnabled configBean `debuggingEnabled`, which selects onError's page for a save legacy cannot run.
 */
export function registerRaterRoutes(
  app: FastifyInstance,
  ctx: RaterRouteContext,
  debuggingEnabled: boolean = legacyDebuggingEnabled(),
): void {
  const { domain } = ctx;
  const errorPage = { debuggingEnabled, encodeHtml: (text: string) => esapiEncode('html', text) };

  app.route({
    method: ['GET', 'POST'],
    url: RATER_SAVE_PATH,
    config: { opt2: ROUTE_AUTH },
    async handler(request, reply) {
      const fields = rateFields(request);
      // Legacy writes nothing for a save it cannot run.
      if (fields === undefined || fields instanceof LegacyFaultError) {
        return sendLegacyResponse(reply, legacyRuntimeErrorResponse(fields, errorPage));
      }
      const claims = request.opt2Auth.user;
      if (claims === undefined) throw AuthDenial.unauthenticated('missing-credential');
      assertSiteMatches(fields.siteId, claims);
      const write = writeContextFor(actorFromClaims(claims, ''), request.id);
      const now = domain.clock.now();
      // SQL Server matches `siteID` ignoring case, so the token's spelling, which the stored rows carry, stands for the posted one.
      const avg = await withGatedTenant(domain.db, claims.tid, (tx) =>
        saveRate(tx, domain.repository, { ...fields, siteId: claims.site, now }, write),
      );
      const body = muraJsonEncode({ kind: 'query', columnList: [...AVG_RATING_COLUMNS], rows: avg === null ? [] : [{ ...avg }] });
      return sendLegacyResponse(reply, { status: 200, headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE }, body });
    },
  });
}
