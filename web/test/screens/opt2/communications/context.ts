// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
// Screen contexts of the communications suites, built without the screen registry, whose OPT-2 umbrella is assembled
// separately from the module barrels.
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { Roles, type Role } from '@opt2/platform/auth';
import { businessClock } from '@opt2/platform/testing';
import type { components } from '@/generated/clients/identity';
import { createCsrfRenderer } from '@/lib/csrf';
import { toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { ScreenContext } from '@/screens/registry';
import { communicationsAnswers } from '../../../fixtures/opt2/communications';
import { opt2RoleRequest, type AdminRequestPartial } from '../../../helpers/admin-request';
import { fragmentModel, normaliseIds, type DomModel } from '../../../helpers/dom-model';
import {
  fakeGatewayClient,
  routeKey,
  type FakeCall,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../../helpers/fake-gateway';

type IssuedCsrfToken = components['schemas']['CsrfTokenSet']['tokens'][number];

/** The pair identity issues for the collections' empty CSRF context. */
export const COLLECTION_CSRF: Readonly<IssuedCsrfToken> = Object.freeze({
  context: '',
  csrf_token: 'C0MMUN1CAT10NSCSRF00000000000001',
  csrf_token_expires: '260630150000000',
});

export const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');

/** The posted CSRF pair as form fields. */
export const POSTED_CSRF: Readonly<Record<string, string>> = Object.freeze({
  [CSRF_FIELD_TOKEN]: COLLECTION_CSRF.csrf_token,
  [CSRF_FIELD_EXPIRES]: COLLECTION_CSRF.csrf_token_expires,
});

/** The tenant-a request of a user holding `role` (default `communications.sender`). */
export function senderRequest(
  partial: AdminRequestPartial = {},
  role: Role = Roles.communicationsSender,
): AdminRequest {
  return opt2RoleRequest(role, partial);
}

/** A 200 list answer holding `items`, its `pageindex` and `totalpages` as given for the pager. */
export function listAnswer(
  items: readonly unknown[],
  pageindex = 1,
  totalpages = items.length === 0 ? 0 : 1,
): FakeReply {
  const counts = { startindex: 1, endindex: items.length, itemsperpage: 50, totalitems: items.length };
  return { status: 200, body: { data: { items, ...counts, totalpages, pageindex } } };
}

/** The service's 404 `notFound` envelope. */
export const NOT_FOUND_ANSWER: FakeReply = Object.freeze({
  status: 404,
  body: {
    apiversion: 'v1',
    method: 'communications.messages',
    error: { message: 'Not Found', code: 'invalid_request' },
  },
});

/** A context over a fake gateway answering the communications fixtures and identity's CSRF pair, plus `routes`. */
export function screenContext(
  req: AdminRequest = senderRequest(),
  routes: FakeRouteTable = {},
): ScreenContext & { gateway: FakeGatewayClient } {
  const gateway = fakeGatewayClient({
    ...communicationsAnswers,
    [CSRF_ROUTE]: { status: 200, body: { tokens: [COLLECTION_CSRF] } },
    ...routes,
  });
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor(req.session.rb),
    hooks: { secondaryMenus: {} },
    now: businessClock().now(),
  };
}

/** The calls the communications service received, in order. */
export function communicationsCalls(gateway: FakeGatewayClient): FakeCall[] {
  return gateway.calls.filter((call) => call.service === 'communications');
}

/** The parity DOM model of a screen body, ids and tokens masked. */
export function bodyModel(body: SafeHtml): DomModel {
  return normaliseIds(fragmentModel(toString(body)));
}
