/** `rater/ajax/saveRate.cfm`: saves the posted rating and answers the item's average rating as Mura.json encodes it. */
import { AuthDenial, assertSiteMatches, type Opt2RouteConfig } from '@opt2/platform/auth';
import {
  LEGACY_HTML_CONTENT_TYPE,
  LegacyFaultError,
  javaTrim,
  legacyDebuggingEnabled,
  legacyRuntimeErrorResponse,
  nullInsertFault,
  truncationFault,
} from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { legacyScopesOf, sendLegacyResponse, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { actorFromClaims, writeContextFor, type DomainDeps } from '../domain/context.js';
import { rateOutcome, saveRate } from '../domain/stats.js';
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

/** The ratings table and the key columns its insert binds, in its order, with their widths [rateBean.cfc:87-91]. */
const RATING_TABLE = 'tcontentratings';
const RATING_KEY_COLUMNS: ReadonlyArray<readonly [column: 'contentID' | 'userID' | 'siteID', width: number]> = Object.freeze([
  ['contentID', 35],
  ['userID', 35],
  ['siteID', 25],
]);

/** The form fields the template passes to raterManager.saveRate, with the rate as SQL Server stores it. */
interface RateFields {
  contentId: string;
  siteId: string;
  userId: string;
  rate: number;
}

/**
 * The template's `form.contentID`, `form.siteID`, `form.userID` and `form.rate`, read ignoring case, or the fault legacy
 * fails the save with: the first missing field, read in that order; a rate {@link rateOutcome} refuses; then, as the
 * rating insert binds them, the first trimmed id that is empty, bound as NULL, or longer than its column; then the rate
 * outside `int`. `database` names the legacy database in SQL Server's messages.
 */
function rateFields(request: FastifyRequest, database: string): RateFields | LegacyFaultError {
  const form = new Map(legacyScopesOf(request).form.entries.map(([name, value]) => [name.toLowerCase(), String(value)]));
  const missing = RATE_FORM_FIELDS.find((name) => !form.has(name.toLowerCase()));
  if (missing !== undefined) return new LegacyFaultError(`Element ${missing.toUpperCase()} is undefined in FORM.`);
  const [contentId = '', siteId = '', userId = '', rateText = ''] = RATE_FORM_FIELDS.map((name) => form.get(name.toLowerCase()));
  const rate = rateOutcome(rateText);
  if ('refused' in rate) return rate.refused;
  const ids = { contentID: contentId, userID: userId, siteID: siteId };
  for (const [column, width] of RATING_KEY_COLUMNS) {
    const id = javaTrim(ids[column]);
    if (id === '') return nullInsertFault(database, RATING_TABLE, column);
    if (id.length > width) return truncationFault(database, RATING_TABLE, column, id, width);
  }
  return rate.stored instanceof LegacyFaultError ? rate.stored : { contentId, siteId, userId, rate: rate.stored };
}

/**
 * Registers `GET` and `POST` of the rater's save, as the template answers any method, written in the verified token's tenant.
 * @param debuggingEnabled configBean `debuggingEnabled`, which selects onError's page for a save legacy cannot run.
 * @param database the legacy database `MURA_DATABASE` names, which SQL Server's messages qualify the table with.
 */
export function registerRaterRoutes(
  app: FastifyInstance,
  ctx: RaterRouteContext,
  debuggingEnabled: boolean = legacyDebuggingEnabled(),
  database: string = process.env.MURA_DATABASE ?? '',
): void {
  const { domain } = ctx;
  const errorPage = { debuggingEnabled, encodeHtml: (text: string) => esapiEncode('html', text) };

  app.route({
    method: ['GET', 'POST'],
    url: RATER_SAVE_PATH,
    config: { opt2: ROUTE_AUTH },
    async handler(request, reply) {
      const fields = rateFields(request, database);
      // Legacy writes nothing for a save it cannot run.
      if (fields instanceof LegacyFaultError) return sendLegacyResponse(reply, legacyRuntimeErrorResponse(fields, errorPage));
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
