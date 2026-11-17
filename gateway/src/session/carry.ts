// Carry of the session values target routes keep in identity into the legacy session of a legacy-bound admin request.
import { createHash } from 'node:crypto';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { isBridgeSessionMismatch, type BridgeClient, type CarriedValue } from './bridge-client.js';
import { liveCookies, unlessIdentityDown } from './csrf.js';
import type { IdentityClient, SessionAdminState } from './identity-client.js';
import type { LegacyJar } from './jar.js';
import type { SessionMode } from './mode.js';

/**
 * Top-level legacy `session` keys a target route writes and a legacy-served admin view reads, which strategies-content
 * keeps under `mura` in identity's admin state: carch.list's `session.flatViewArgs` (admin/core/views/carch/list.cfm:492-584),
 * which carch.loadSiteFlat reads without a default (admin/core/views/carch/loadsiteflat.cfm:109).
 */
export const CARRIED_SESSION_KEYS: readonly string[] = Object.freeze(['flatViewArgs']);

/** Per-request facts the bridge call forwards. */
export interface CarryCall {
  /** The browser's `User-Agent`, which keeps Masa's session timeout. */
  userAgent?: string | undefined;
}

/** Keeps a legacy session holding the session values target routes stored in identity. */
export interface SessionCarry {
  /**
   * Installs identity's stored values of {@link CARRIED_SESSION_KEYS} in the legacy session the session's jar attaches;
   * a value identity has not changed since its last install leaves legacy's own writes standing.
   */
  beforeLegacy(sessionId: string, mode: SessionMode, call?: CarryCall): Promise<void>;
}

/** Dependencies of {@link createSessionCarry}. */
export interface SessionCarryOptions {
  identity: Pick<IdentityClient, 'adminState'>;
  bridge: Pick<BridgeClient, 'carry'>;
  jar: Pick<LegacyJar, 'get'>;
  /** Judges cookie expiry; defaults to the system clock. */
  clock?: Clock;
}

/** `state.mura[name]` when it is a struct, the name matched case-insensitively as strategies-content reads it. */
function storedStruct(state: SessionAdminState, name: string): Readonly<Record<string, unknown>> | undefined {
  const mura = state.mura ?? {};
  const key = Object.keys(mura).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : mura[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The revision of a carried value: the SHA-256 of its JSON text. */
function revisionOf(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Creates the carry over identity's stored admin state, the bridge's `op=carry` and the jar. */
export function createSessionCarry(opts: SessionCarryOptions): SessionCarry {
  const { identity, bridge, jar } = opts;
  const clock = opts.clock ?? systemClock;

  return {
    async beforeLegacy(sessionId, mode, call = {}) {
      const row = await jar.get(sessionId);
      // Without a known legacy session, ColdFusion starts one for the request, which no target route has written to.
      if (row === undefined || row.legacySessionId === null) return;
      const { legacySessionId } = row;
      const cookies = liveCookies(row.cookies, clock.now());
      if (Object.keys(cookies).length === 0) return;
      // In legacy-primary legacy alone holds the session, so identity's absence leaves it as it is.
      const state = await unlessIdentityDown(mode, () => identity.adminState(sessionId));
      if (state === undefined) return;
      const values: CarriedValue[] = [];
      for (const name of CARRIED_SESSION_KEYS) {
        const value = storedStruct(state, name);
        if (value !== undefined) values.push({ name, value, revision: revisionOf(value) });
      }
      if (values.length === 0) return;
      try {
        await bridge.carry(cookies, values, { legacySessionId, userAgent: call.userAgent });
      } catch (error) {
        // Legacy-primary cookies that no longer attach the jar's session reach a session no target route wrote to.
        if (mode === 'legacy-primary' && isBridgeSessionMismatch(error)) return;
        throw error;
      }
    },
  };
}
