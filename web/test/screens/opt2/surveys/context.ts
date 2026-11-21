// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// Requests, fake gateways and renderers shared by the surveys screen suites.
import { Roles } from '@opt2/platform/auth';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext, SubmitResult } from '@/screens/registry';
import { surveysActions, surveysScreens } from '@/screens/opt2/surveys';
import { surveysAnswers } from '../../../fixtures/opt2/surveys';
import { opt2RoleRequest } from '../../../helpers/admin-request';
import { fragmentModel, normaliseIds, type DomModel } from '../../../helpers/dom-model';
import { fakeGatewayClient, type FakeGatewayClient, type FakeRouteTable } from '../../../helpers/fake-gateway';
import { makeScreenContext } from '../../../helpers/screen-context';

export const SITE = 'tenant-a';
export const NOACCESS = '/admin/?muraAction=cMessage.noaccess';
export const LOGOUT = '/admin/?muraAction=clogin.logout';

/** A surveys.manager request on tenant-a with `rc` laid over the session site. */
export const managerRequest = (rc: Record<string, string> = {}): AdminRequest =>
  opt2RoleRequest(Roles.surveysManager, { rc: { siteid: SITE, ...rc } });

/** A gateway answering the surveys fixtures, `overrides` replacing any of them. */
export const surveysGateway = (overrides: FakeRouteTable = {}): FakeGatewayClient =>
  fakeGatewayClient({ ...surveysAnswers, ...overrides });

/** The registered surveys screen `screen`. */
export function surveysScreen(screen: string): Opt2ScreenDefinition {
  const def = surveysScreens.find((candidate) => candidate.screen === screen);
  if (def === undefined) throw new TypeError(`surveys/${screen} is not registered`);
  return def;
}

/** The registered surveys post action `action`. */
export function surveysAction(action: string): Opt2ActionDefinition {
  const def = surveysActions.find((candidate) => candidate.action === action);
  if (def === undefined) throw new TypeError(`surveys action ${action} is not registered`);
  return def;
}

/** The screen context of `req` over `gateway`. */
export const contextFor = (
  req: AdminRequest,
  gateway: FakeGatewayClient,
): ScreenContext & { gateway: FakeGatewayClient } => makeScreenContext({ req, gateway });

/** The markup of `screen`'s body for `req` over `gateway`: load, then render, without the shell. */
export async function bodyHtml(screen: string, req: AdminRequest, gateway: FakeGatewayClient): Promise<string> {
  const def = surveysScreen(screen);
  const ctx = contextFor(req, gateway);
  const view = await def.render(ctx, await def.load(ctx));
  return toString(view.body);
}

/** The DOM model of `screen`'s body for `req` over `gateway`, ids and tokens kept. */
export async function bodyModel(screen: string, req: AdminRequest, gateway: FakeGatewayClient): Promise<DomModel> {
  return fragmentModel(await bodyHtml(screen, req, gateway));
}

/** The DOM model of a re-rendered submit outcome's body, CSRF tokens masked. */
export function renderedModel(result: SubmitResult): DomModel {
  if (result.kind !== 'render') throw new Error(`The submit answered ${result.kind}, not a re-render`);
  return normaliseIds(fragmentModel(toString(result.view.body)));
}

/** The surveys calls the gateway received, as method, path, query, JSON body and caller headers. */
export const surveysCalls = (gateway: FakeGatewayClient) =>
  gateway.calls
    .filter(({ service }) => service === 'surveys')
    .map(({ method, path, query, json, headers }) => ({ method, path, query, json, headers }));

/** Every CSRF context identity was asked to issue. */
export const csrfContexts = (gateway: FakeGatewayClient): string[] =>
  gateway.calls
    .filter(({ service, path }) => service === 'identity' && path === '/v1/csrf/tokens')
    .flatMap(({ json }) => (json as { contexts: string[] }).contexts);
