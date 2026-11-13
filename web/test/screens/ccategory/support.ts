// Shared builders of the ccategory screen tests: category rows, the strategies-content routes and a screen context.
import { readFileSync } from 'node:fs';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { createCsrfRenderer } from '@/lib/csrf';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { ScreenContext } from '@/screens/registry';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type RecordedRequest,
} from '../../helpers/fake-gateway';

/** The pair the fake identity issues for every context, as the oracle fixtures carry it after masking. */
export const CSRF_PAIR = Object.freeze({
  token: `${'0'.repeat(60)}0C01`,
  expires: '260630150000000',
});

/** The `renderCSRFTokens(format="url")` suffix of {@link CSRF_PAIR}. */
export const CSRF_URL = `&csrf_token=${CSRF_PAIR.token}&csrf_token_expires=${CSRF_PAIR.expires}`;

export const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
export const LIST_ROUTE = routeKey('GET', 'strategies-content', '/v1/sites/default/categories');
export const SAVE_ROUTE = routeKey('POST', 'strategies-content', '/v1/sites/default/categories');

/** The `getCategory` route of `categoryid` on `default`. */
export const categoryRoute = (categoryid: string): string =>
  routeKey('GET', 'strategies-content', `/v1/sites/default/categories/${encodeURIComponent(categoryid)}`);

/** An oracle capture of a view body (`#mura-content` inner markup) from `test/fixtures/strategies-content`. */
export function legacyBody(name: string): string {
  return readFileSync(new URL(`../../fixtures/strategies-content/${name}`, import.meta.url), 'utf8');
}

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

/** A fake gateway answering `routes` and identity's CSRF tokens. */
export function categoryGateway(routes: Record<string, FakeReply> = {}): FakeGatewayClient {
  return fakeGatewayClient({ [CSRF_ROUTE]: issueTokens, ...routes });
}

/** The screen context of `req` over `gateway`, with the real CSRF renderer and the session's bundle. */
export function contextFor(
  req: AdminRequest,
  gateway: FakeGatewayClient,
): ScreenContext & { gateway: FakeGatewayClient } {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor(req.session.rb),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

/** A `getCategories` row as strategies-content sends it, with `children` below it. */
export interface CategoryRow {
  readonly categoryID: string;
  readonly parentID: string | null;
  readonly name: string;
  readonly hasKids: number;
  readonly isOpen: number | string | boolean | null;
  readonly isInterestGroup: number;
  readonly isActive: number;
  readonly restrictGroups: string | null;
  readonly children: readonly CategoryRow[];
}

/** A row with every flag on and no restriction; `fields` replace any member. */
export function categoryRow(categoryID: string, name: string, fields: Partial<CategoryRow> = {}): CategoryRow {
  const children = fields.children ?? [];
  return {
    categoryID,
    parentID: null,
    name,
    hasKids: children.length,
    isOpen: 1,
    isInterestGroup: 1,
    isActive: 1,
    restrictGroups: '',
    children,
    ...fields,
  };
}

export const ALPHA_ID = 'CA000000-0000-0000-0000000000000001';
export const BETA_ID = 'CA000000-0000-0000-0000000000000002';
export const GAMMA_ID = 'CA000000-0000-0000-0000000000000003';

/** Alpha with child Beta (itself with child Gamma), then the restricted, closed Delta. */
export function categoryTree(): CategoryRow[] {
  const gamma = categoryRow(GAMMA_ID, 'Gamma', { parentID: BETA_ID });
  const beta = categoryRow(BETA_ID, 'Beta <b>', { parentID: ALPHA_ID, isInterestGroup: 0, children: [gamma] });
  return [
    categoryRow(ALPHA_ID, 'Alpha & Co', { children: [beta] }),
    categoryRow('CA000000-0000-0000-0000000000000004', 'Delta', {
      isOpen: 0,
      isActive: 0,
      restrictGroups: 'Editor',
    }),
  ];
}
