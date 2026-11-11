// Session mode decision: whether legacy or identity issues the browser's session cookies.
import type { RoutingIndex } from '../cutover/types.js';

/** Route key of the admin login action, whose write group decides the session mode. */
export const LOGIN_ROUTE_KEY = 'admin:clogin.login';

/** Which side issues the browser's session cookies. */
export type SessionMode = 'legacy-primary' | 'target-primary';

/** Session mode of the active cut-over version; `legacy-primary` while no version is active. */
export function sessionModeFor(index: RoutingIndex | undefined): SessionMode {
  return index?.loginGroupAuthority() === 'target' ? 'target-primary' : 'legacy-primary';
}
