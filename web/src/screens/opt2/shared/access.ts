// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { hasAnyRole, type Role } from '@opt2/platform/auth';
import type { ScreenGate } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { noAccessUrl } from './paths';

/** Whether the verified user token grants any of `roles`; request parameters and headers never grant a role. */
export function canUse(req: AdminRequest, roles: readonly Role[]): boolean {
  return hasAnyRole(req.user?.roles ?? [], roles);
}

/** Deny-by-default gate: anonymous → `secure()`, no listed role → `cMessage.noaccess`; S2 has no implicit bypass. */
export function opt2Gate(roles: readonly Role[]): ScreenGate {
  return (req, { secure }) => {
    if (!req.isLoggedIn) return secure();
    if (!canUse(req, roles)) return { kind: 'redirect', location: noAccessUrl() };
    return { kind: 'allow' };
  };
}
