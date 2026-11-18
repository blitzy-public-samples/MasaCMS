// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
// Reporting test contexts and shell routes, built here so these suites load without the full circuit registry.
import * as cheerio from 'cheerio';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, type CsrfTokens } from '@opt2/platform/legacy-compat';
import { createCsrfRenderer } from '@/lib/csrf';
import { LEGACY_VERSION_MENU_PATH } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { ScreenContext } from '@/screens/registry';
import { LEGACY_VERSION_MENU } from '../../../fixtures/gateway/version-menu';
import { routeKey, type FakeGatewayClient, type FakeReply, type FakeRouteTable, type RecordedRequest } from '../../../helpers/fake-gateway';

/** The pair identity issues for every CSRF context in these tests. */
export const CSRF_PAIR: Readonly<CsrfTokens> = Object.freeze({
  token: 'REPORTINGCSRFTOKEN00000000000000',
  expires: '260630150000000',
});

export const LIST_PATH = '/v1/reporting/exports';
export const LIST_ROUTE = routeKey('GET', 'reporting', LIST_PATH);
export const DEFINITIONS_PATH = '/v1/reporting/definitions';
export const DEFINITIONS_ROUTE = routeKey('GET', 'reporting', DEFINITIONS_PATH);
export const CSRF_PATH = '/v1/csrf/tokens';
export const CSRF_ROUTE = routeKey('POST', 'identity', CSRF_PATH);

/** identity `issueCsrfTokens`: {@link CSRF_PAIR} for each requested context, in request order. */
function issueTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({
    context,
    [CSRF_FIELD_TOKEN]: CSRF_PAIR.token,
    [CSRF_FIELD_EXPIRES]: CSRF_PAIR.expires,
  }));
  return { status: 200, body: { tokens } };
}

/** identity's CSRF issuance plus the routes `loadShellData` reads for `siteId`'s full layout. */
export function shellAndCsrfRoutes(siteId: string): FakeRouteTable {
  return {
    [CSRF_ROUTE]: issueTokens,
    [routeKey('GET', 'programs-sites', '/v1/user-sites')]: {
      status: 200,
      body: {
        sites: [{ siteid: siteId, site: siteId, orderno: 1, domain: 'localhost', domainAlias: null, showDashboard: 0 }],
      },
    },
    [routeKey('GET', 'strategies-content', `/v1/sites/${siteId}/header-prompts`)]: {
      status: 200,
      body: { drafts: 0, submissions: 0, approvals: 0, expires: 0, pendingChangesets: 0 },
    },
    [routeKey('GET', 'gateway', LEGACY_VERSION_MENU_PATH)]: { status: 200, body: LEGACY_VERSION_MENU },
  };
}

/** The cell texts of each job row of the job grid in `markup`, in document order. */
export function jobValues(markup: string): string[][] {
  const $ = cheerio.load(markup);
  return $('table.mura-table-grid > tbody > tr')
    .toArray()
    .map((row) =>
      $(row)
        .children('td')
        .toArray()
        .map((cell) => $(cell).text()),
    );
}

/** The ScreenContext the OPT-2 handlers build for `req`, over `gateway`. */
export function contextFor(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}
