// ScreenContext factory and in-shell page renderer for screen tests, over the fake gateway client (no Next.js).
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, type CsrfTokens } from '@opt2/platform/legacy-compat';
import { businessClock } from '@opt2/platform/testing';
import { deniedGate, runGate } from '@/lib/access-gate';
import { createCsrfRenderer, type CsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import {
  shellHooks,
  type Opt2ScreenDefinition,
  type PageScreen,
  type ScreenContext,
  type ScreenDefinition,
  type ScreenRequestBody,
} from '@/screens/registry';
import {
  loadShellData,
  renderAdminDocument,
  serializeAdminDocument,
  type AdminDocument,
  type ShellHooks,
} from '@/shell/document';
import { domModel, normaliseIds, type DomModel } from './dom-model';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
  type RecordedRequest,
} from './fake-gateway';

/** The pair identity issues for every CSRF context: a 32-character token expiring 3 hours after `businessClock()`. */
export const FIXED_CSRF: Readonly<CsrfTokens> = Object.freeze({
  token: 'TESTCSRFTOKEN0000000000000000000',
  expires: '260630150000000',
});

/** Site the shell routes serve when no session site is named. */
const SHELL_SITE = 'default';

/** programs-sites `listUserSites` row of the installed `default` site, its dashboard hidden. */
const DEFAULT_USER_SITE = Object.freeze({
  siteid: SHELL_SITE,
  site: 'Default',
  orderno: 1,
  domain: 'localhost',
  domainAlias: null,
  showDashboard: 0,
});

/** strategies-content `getHeaderPrompts` with nothing to prompt. */
const NO_PROMPTS = Object.freeze({ drafts: 0, submissions: 0, approvals: 0, expires: 0, pendingChangesets: 0 });

/** identity `issueCsrfTokens`: one {@link FIXED_CSRF} pair per requested context, in request order. */
function issueFixedTokens(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({
    context,
    [CSRF_FIELD_TOKEN]: FIXED_CSRF.token,
    [CSRF_FIELD_EXPIRES]: FIXED_CSRF.expires,
  }));
  return { status: 200, body: { tokens } };
}

/**
 * Replies to every call `loadShellData` and `createCsrfRenderer` make: identity's tokens, `default` as the user's only
 * site and no header prompts for `siteId`; `overrides` replace any of them.
 */
export function shellRoutes(overrides: FakeRouteTable = {}, siteId: string = SHELL_SITE): FakeRouteTable {
  return {
    [routeKey('POST', 'identity', '/v1/csrf/tokens')]: issueFixedTokens,
    [routeKey('GET', 'programs-sites', '/v1/user-sites')]: { status: 200, body: { sites: [DEFAULT_USER_SITE] } },
    [routeKey('GET', 'strategies-content', `/v1/sites/${encodeURIComponent(siteId)}/header-prompts`)]: {
      status: 200,
      body: NO_PROMPTS,
    },
    ...overrides,
  };
}

/** Inputs of {@link makeScreenContext}; each absent member defaults as the admin handlers build it. */
export interface ScreenContextInput {
  readonly req: AdminRequest;
  /** Gains each {@link shellRoutes} route it does not already hold. */
  readonly gateway?: FakeGatewayClient;
  readonly csrf?: CsrfRenderer;
  readonly rb?: RbLookup;
  readonly hooks?: ShellHooks;
  readonly now?: Date;
  readonly body?: ScreenRequestBody;
}

/** The ScreenContext of `input.req`, with the real CSRF renderer, bundles and shell hooks over a fake gateway. */
export function makeScreenContext(input: ScreenContextInput): ScreenContext & { gateway: FakeGatewayClient } {
  const { req } = input;
  const gateway = input.gateway ?? fakeGatewayClient();
  for (const [key, route] of Object.entries(shellRoutes({}, req.session.siteid))) {
    if (!gateway.hasRoute(key)) gateway.setRoute(key, route);
  }
  return {
    req,
    gateway,
    csrf: input.csrf ?? createCsrfRenderer(gateway),
    // As the handlers build it: `session.rb` is always a string, which the bundle chain resolves.
    rb: input.rb ?? rbFor(req.session.rb),
    hooks: input.hooks ?? shellHooks,
    now: input.now ?? businessClock().now(),
    body: input.body,
  };
}

/** A page render's answer: the serialized document, or the redirect a gate or a service denial sent. */
export type RenderedPage =
  | { kind: 'document'; html: string; doc: AdminDocument }
  | { kind: 'redirect'; location: string };

/** A definition rendered inside the shell. */
type PageDefinition = PageScreen<any> | Opt2ScreenDefinition;

/** `def` when it renders inside the shell; fragment, JSON, download and redirect screens are called directly. */
function pageDefinition(def: ScreenDefinition | Opt2ScreenDefinition): PageDefinition {
  if (!('mode' in def) || def.mode === 'page') return def;
  throw new Error(`${def.circuit}.${def.action} is a ${def.mode}-mode screen; call its own function instead`);
}

/**
 * The page production answers for `def` in `ctx`: gate, load, render, then the legacy shell; a service denial answers
 * with the access gate's redirect. Callers install `useTestEnv()` first, since the gate and shell read the settings.
 * @throws Error For a screen not in page mode, or one whose controller redirect step fires.
 */
export async function renderScreenPage(
  def: ScreenDefinition | Opt2ScreenDefinition,
  ctx: ScreenContext,
): Promise<RenderedPage> {
  const page = pageDefinition(def);
  try {
    const decision = await runGate(ctx.req, page.gate);
    if (decision.kind === 'redirect') return { kind: 'redirect', location: decision.location };
    // The FW/1 redirect target is built by web's internal URL helpers, so a firing step is asserted on its own.
    const step = 'mode' in page ? await page.redirect?.(ctx) : undefined;
    if (step !== undefined) {
      const target = step.kind === 'location' ? step.location : step.action;
      throw new Error(`The page redirect step fires (to ${target}); assert on the screen's redirect(ctx) instead`);
    }
    const data: unknown = page.load === undefined ? undefined : await page.load(ctx);
    const view = await page.render(ctx, data);
    const shell = await loadShellData(ctx.req, { gateway: ctx.gateway, csrf: ctx.csrf, rb: ctx.rb, now: ctx.now });
    const doc = renderAdminDocument(ctx.req, view, ctx.hooks, shell);
    return { kind: 'document', html: serializeAdminDocument(doc), doc };
  } catch (error) {
    if (!(error instanceof GatewayDenialError)) throw error;
    const denied = deniedGate(error.status);
    if (denied.kind === 'redirect') return { kind: 'redirect', location: denied.location };
    throw error;
  }
}

/** The parity DOM model of {@link renderScreenPage}'s document, ids and tokens masked; throws on a redirect. */
export async function renderScreenModel(
  def: ScreenDefinition | Opt2ScreenDefinition,
  ctx: ScreenContext,
): Promise<DomModel> {
  const page = await renderScreenPage(def, ctx);
  if (page.kind === 'redirect') throw new Error(`The screen redirected to ${page.location}`);
  return normaliseIds(domModel(page.html));
}
