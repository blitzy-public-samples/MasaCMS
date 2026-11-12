// The admin access gate: where legacy sends users without site access, anonymous users and unauthorised users (server-only).
import { ADMIN_LOGIN_REDIRECT_ACTION, ADMIN_NOACCESS_ACTION, cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { legacySettings } from './env';
import type { AdminRequest } from './request-context';
import { adminPath, fw1RedirectTarget, sanitizeHref, type HrefDomains } from './urls';

/** Outcome of a gate: let the request through, or answer 302 with `location` as the `Location` header. */
export type GateDecision = { readonly kind: 'allow' } | { readonly kind: 'redirect'; readonly location: string };

/** A screen's controller `before()` check; `secure` is the controller's `secure()` for this request. */
export type ScreenGate = (
  req: AdminRequest,
  helpers: { readonly secure: () => GateDecision },
) => GateDecision | Promise<GateDecision>;

/** Options of {@link secure} and {@link runGate}. */
export interface GateOptions {
  /** Site-registry domains the login return URL is sanitized against; defaults to the request's `hrefDomains`. */
  readonly hrefDomains?: HrefDomains;
}

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

const redirectTo = (location: string): GateDecision => ({ kind: 'redirect', location });

/** Circuits, lower-cased, that a logged-in user who administers no site may still reach. */
const SITELESS_CIRCUITS: ReadonlySet<string> = new Set(['clogin', 'cmessage', 'ceditprofile']);

/** `<context><adminDir>/?muraAction=<action>`, the absolute-path `Location` the application gate sends. */
function adminActionPath(action: string): string {
  const { context, adminDir } = legacySettings();
  return `${context}${adminDir}/?muraAction=${action}`;
}

/** Section of a `muraAction` value without its subsystem, e.g. `cusers` for `core:cusers.list`. */
function circuitOf(muraAction: string): string {
  const section = cfListToArray(muraAction, '.')[0] ?? '';
  return cfListToArray(section, ':').at(-1) ?? '';
}

/** Admin `setupRequest` gate: a logged-in user without site access may reach only login, messages and their profile. */
export function applicationGate(req: AdminRequest): GateDecision {
  if (!req.isLoggedIn || req.session.siteArray.length > 0) return ALLOW;
  const muraAction = req.rc['muraAction'] ?? '';
  const circuit = circuitOf(muraAction);
  if (!req.session.s2IsPrivate && !cfEq(circuit, 'clogin')) {
    return redirectTo(adminActionPath(ADMIN_LOGIN_REDIRECT_ACTION));
  }
  if (muraAction === '' || !SITELESS_CIRCUITS.has(circuit.toLowerCase())) {
    return redirectTo(adminActionPath(ADMIN_NOACCESS_ACTION));
  }
  return ALLOW;
}

/** Handlers answer a GatewayDenialError with this: clogin.logout for its 401, cMessage.noaccess for its 403. */
export function deniedGate(status: 401 | 403): GateDecision {
  return redirectTo(adminActionPath(status === 401 ? ADMIN_LOGIN_REDIRECT_ACTION : ADMIN_NOACCESS_ACTION));
}

/**
 * Controller `secure()`: anonymous users go to the login form with a return URL, logged-in users back to the referrer.
 * @throws TypeError For an anonymous request carrying no registry domains, since the browser's Host is never trusted.
 */
export function secure(req: AdminRequest, { hrefDomains = req.hrefDomains }: GateOptions = {}): GateDecision {
  if (req.isLoggedIn) return redirectTo(req.headers.get('referer') || './');
  if (hrefDomains === undefined) throw new TypeError('secure() needs the registry domains of an anonymous request');
  const currentAdminPath = sanitizeHref(
    adminPath({ useProtocol: true, domain: req.serverName, https: req.https, httpHost: req.httpHost }),
    hrefDomains,
  );
  const append: Array<readonly [string, string]> = [['returnURL', currentAdminPath + req.currentUrl.replace('.', '')]];
  const compactDisplay = req.rc['compactDisplay'];
  if (compactDisplay !== undefined) append.push(['compactDisplay', compactDisplay]);
  return redirectTo(fw1RedirectTarget({ action: 'cLogin.main', path: './', append, ses: req.ses }));
}

/** The application gate, then the screen's own gate when one is supplied and the request got through. */
export async function runGate(
  req: AdminRequest,
  screenGate?: ScreenGate,
  options: GateOptions = {},
): Promise<GateDecision> {
  const decision = applicationGate(req);
  if (decision.kind === 'redirect' || screenGate === undefined) return decision;
  return screenGate(req, { secure: () => secure(req, options) });
}
