// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
// Requests, gateways, settings and lookups shared by the finance screen suites.
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { Roles, type Role } from '@opt2/platform/auth';
import { vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { financeActions, financeScreens } from '@/screens/opt2/finance';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, SubmitResult } from '@/screens/registry';
import { FINANCE_IDS, financeAnswers } from '../../../fixtures/opt2/finance';
import { opt2RoleRequest, type AdminRequestPartial } from '../../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../../helpers/fake-gateway';
import { FIXED_CSRF } from '../../../helpers/screen-context';

export const SITE = 'tenant-a';
export const NOACCESS = '/admin/?muraAction=cMessage.noaccess';
export const LOGOUT = '/admin/?muraAction=clogin.logout';

export const PREPARER: Role = Roles.financePreparer;
export const APPROVER: Role = Roles.financeApprover;

/** The record the detail fixtures describe: RE-SUBMITTED at version 6 with six versions and two attachments. */
export const RECORD_ID = FINANCE_IDS.recordResubmitted;

export const RECORD_ROUTE = routeKey('GET', 'finance', `/v1/finance/records/${RECORD_ID}`);
export const LIST_ROUTE = routeKey('GET', 'finance', '/v1/finance/records');

/** The CSRF pair identity issues in these suites, as a form posts it. */
export const POSTED_CSRF: Readonly<Record<string, string>> = Object.freeze({
  [CSRF_FIELD_TOKEN]: FIXED_CSRF.token,
  [CSRF_FIELD_EXPIRES]: FIXED_CSRF.expires,
});

/** The posted CSRF pair as the `X-csrf_token` headers finance receives. */
export const CSRF_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-csrf_token': FIXED_CSRF.token,
  'x-csrf_token_expires': FIXED_CSRF.expires,
});

/** A finance envelope error answer of `status` for `method`. */
export function financeError(status: number, method: string, message: string, code = 'invalid_request'): FakeReply {
  return { status, body: { apiversion: 'v1', method, error: { code, message } } };
}

/** The tenant-a request of a user holding `role`, with `rc` laid over its context. */
export function financeRequest(
  role: Role,
  rc: Readonly<Record<string, string>> = {},
  partial: AdminRequestPartial = {},
): AdminRequest {
  return opt2RoleRequest(role, { ...partial, rc: { siteid: SITE, ...rc } });
}

/** The tenant-a request of a user holding both finance roles. */
export function preparerApproverRequest(rc: Readonly<Record<string, string>> = {}): AdminRequest {
  return financeRequest(PREPARER, rc, { user: { roles: [Roles.systemUser, PREPARER, APPROVER] } });
}

/** A gateway answering the finance fixtures, `overrides` replacing any of them. */
export function financeGateway(overrides: FakeRouteTable = {}): FakeGatewayClient {
  return fakeGatewayClient({ ...financeAnswers, ...overrides });
}

/** The finance screen `screen`. */
export function financeScreen(screen: string): Opt2ScreenDefinition {
  const def = financeScreens.find((candidate) => candidate.screen === screen);
  if (def === undefined) throw new TypeError(`finance/${screen} is not exported`);
  return def;
}

/** The finance post action `action`. */
export function financeAction(action: string): Opt2ActionDefinition {
  const def = financeActions.find((candidate) => candidate.action === action);
  if (def === undefined) throw new TypeError(`finance/${action} is not exported`);
  return def;
}

/** A re-rendering submit outcome's OPT-2 module and body DOM model; throws for any other outcome. */
export function rerendered(result: SubmitResult): { readonly module?: string; readonly model: DomModel } {
  if (result.kind !== 'render') throw new Error(`Expected a re-render, got ${result.kind}`);
  return { module: result.view.opt2Module, model: fragmentModel(toString(result.view.body)) };
}

/** The finance calls `gateway` received, as `METHOD path`, in order. */
export function financeCalls(gateway: FakeGatewayClient): string[] {
  return gateway.calls.filter(({ service }) => service === 'finance').map(({ method, path }) => `${method} ${path}`);
}

/** Installs the test environment over template settings, the host's `MURA_` variables hidden; returns the restore. */
export function useFinanceEnv(): () => void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  resetLegacySettingsForTests();
  const restoreEnv = useTestEnv();
  return () => {
    restoreEnv();
    vi.unstubAllEnvs();
    resetLegacySettingsForTests();
  };
}
