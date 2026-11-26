// The session values target-served and legacy-served requests share: identity's carried into the legacy session
// before a legacy-bound request whose legacy code reads them, legacy's changes imported into identity after it.
import { createHash } from 'node:crypto';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import {
  isBridgeSessionMismatch,
  type BridgeClient,
  type CarriedValue,
  type ExportedValue,
  type LegacyCookies,
  type SharedJsonValue,
} from './bridge-client.js';
import { liveCookies, unlessIdentityDown } from './csrf.js';
import type { IdentityClient, MuraBases, SessionAdminState } from './identity-client.js';
import type { LegacyJar } from './jar.js';
import type { SessionMode } from './mode.js';

/** Top-level admin-state keys whose value is a string. */
type StringStateKey = { [K in keyof SessionAdminState]-?: NonNullable<SessionAdminState[K]> extends string ? K : never }[keyof SessionAdminState];

/** Top-level admin-state keys a shared value occupies: the string keys, the FW/1 preserve-key counter and contexts, and the module tops. */
type SharedStateKey = StringStateKey | 'nextPreserveKey' | 'flash' | 'moduleTopIds';

/** Prefix of a location inside `session.mura`, on the bridge and in identity's admin state alike. */
const MURA_PREFIX = 'mura.';

/** FW/1's `maxNumContextsPreserved` (admin/framework.cfc:1169-1170): allocating preserve key k purges the context at k - 10. */
const MAX_PRESERVED_CONTEXTS = 10;

/** One shared session value: its bridge wire name and where identity's admin state keeps it. */
export interface SharedSessionValue {
  /**
   * `op=carry` and `op=export` name: a top-level legacy `session` key, `mura.<key>` for a `session.mura` key, `__fw1`
   * for the FW/1 preserved contexts `session['__fw1<key>']`, or `moduleTopIds` for the module tops `session[<key>].topid`.
   */
  readonly wire: string;
  /** A top-level key of identity's admin state, or `mura.<key>` for a key of its `mura` values. */
  readonly identity: SharedStateKey | `mura.${string}`;
}

/**
 * The shared values, as session.cfm's `sharedNames` lists them: `session.flatViewArgs`, which strategies-content keeps
 * under `mura` (admin/core/views/carch/list.cfm:492-584, admin/core/controllers/carch.cfc:516-523); `session.mura.nextN`
 * (list.cfm:459-460); `session.mura.alerts` (admin/common/layouts/template.cfm:262-265, admin/core/controllers/cdashboard.cfc:142-153);
 * the admin site switch (admin/Application.cfc:384-397); `session.keywords` (carch.cfc:490); the form data manager's
 * `session.datakeywords` and `session.filterBy` (admin/core/views/carch/datamanager.cfm:79-86); FW/1's preserve-key
 * counter and preserved contexts (admin/framework.cfc:1432-1456, 1554-1600), which carry installs but export never reads;
 * carch's `session.moduleid`, module tops `session['m<moduleid>']` and `session[<moduleid>]`, and
 * `session.mura.objectInstanceId` (admin/Application.cfc:419-421, carch.cfc:73-107,216-240); and login's strike block
 * `session.blockLoginUntil`, which the login page reads (admin/core/views/clogin/main.cfm:111) and the bridge holds as a
 * date, as legacy's login sets it (core/mura/user/userUtility.cfc:205,253).
 */
export const SHARED_SESSION_VALUES: readonly SharedSessionValue[] = Object.freeze([
  { wire: 'flatViewArgs', identity: 'mura.flatViewArgs' },
  { wire: 'mura.nextN', identity: 'mura.nextN' },
  { wire: 'mura.alerts', identity: 'mura.alerts' },
  { wire: 'siteid', identity: 'siteid' },
  { wire: 'userFilesPath', identity: 'userFilesPath' },
  { wire: 'topID', identity: 'topID' },
  { wire: 'openSectionList', identity: 'openSectionList' },
  { wire: 'keywords', identity: 'keywords' },
  { wire: 'datakeywords', identity: 'datakeywords' },
  { wire: 'filterBy', identity: 'filterBy' },
  { wire: '__fw1NextPreserveKey', identity: 'nextPreserveKey' },
  { wire: '__fw1', identity: 'flash' },
  { wire: 'moduleid', identity: 'moduleid' },
  { wire: 'moduleTopIds', identity: 'moduleTopIds' },
  { wire: 'mura.objectInstanceId', identity: 'mura.objectInstanceId' },
  { wire: 'blockLoginUntil', identity: 'blockLoginUntil' },
]);

/** Per-request facts the bridge call forwards. */
export interface CarryCall {
  /** The browser's `User-Agent`, which keeps Masa's session timeout. */
  userAgent?: string | undefined;
}

/** Keeps a legacy session and identity's admin state holding the same shared session values. */
export interface SessionCarry {
  /**
   * Installs identity's stored values of {@link SHARED_SESSION_VALUES} in the legacy session the session's jar attaches;
   * a value identity has not changed since its last install leaves legacy's own writes standing.
   */
  beforeLegacy(sessionId: string, mode: SessionMode, call?: CarryCall): Promise<void>;
  /**
   * Stores in identity the shared values a completed legacy-bound request changed in the jar's legacy session; of a
   * `mura` struct carry installed, only legacy's changes against the installed struct.
   */
  afterLegacy(sessionId: string, mode: SessionMode, call?: CarryCall): Promise<void>;
}

/** Dependencies of {@link createSessionCarry}. */
export interface SessionCarryOptions {
  identity: Pick<IdentityClient, 'adminState' | 'importAdminState'>;
  bridge: Pick<BridgeClient, 'carry' | 'export'>;
  jar: Pick<LegacyJar, 'get'>;
  /** Judges cookie expiry; defaults to the system clock. */
  clock?: Clock;
}

/** The legacy session a session's jar attaches. */
interface AttachedLegacySession {
  legacySessionId: string;
  cookies: LegacyCookies;
}

/** The preserved contexts FW/1 still holds under the shared counter: keys from `nextPreserveKey - 10` on; undefined when none. */
function liveContexts(state: SessionAdminState): SessionAdminState['flash'] {
  const oldest = (state.nextPreserveKey ?? 1) - MAX_PRESERVED_CONTEXTS;
  const live = Object.entries(state.flash ?? {}).filter(([key]) => Number.isInteger(Number(key)) && Number(key) >= oldest);
  return live.length === 0 ? undefined : Object.fromEntries(live);
}

/**
 * The value identity stores at `location`, the flash as the contexts FW/1 has not purged; `mura` keys match
 * case-insensitively, as strategies-content reads them.
 */
function storedValue(state: SessionAdminState, location: SharedSessionValue['identity']): unknown {
  if (location === 'flash') return liveContexts(state);
  if (!location.startsWith(MURA_PREFIX)) return state[location as SharedStateKey];
  const name = location.slice(MURA_PREFIX.length).toLowerCase();
  const mura = state.mura ?? {};
  const key = Object.keys(mura).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : mura[key];
}

/** True for a value the bridge can install: any JSON value but `null`. */
function isCarriable(value: unknown): value is SharedJsonValue {
  return value !== undefined && value !== null;
}

/** The revision of a carried value: the SHA-256 of its JSON text. */
function revisionOf(value: SharedJsonValue): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** True for a JSON string, number or boolean. */
function isSimple(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Identity's admin-state patch for exported values: the preserve-key counter as an integer, the module tops as a struct of
 * strings, other top-level values as strings (a complex one is skipped), `mura` values under `mura`; a name the table does
 * not list is skipped.
 */
function adminStatePatch(exported: readonly ExportedValue[]): SessionAdminState {
  const patch: Record<string, unknown> = {};
  const mura: Record<string, unknown> = {};
  for (const { name, value } of exported) {
    const location = SHARED_SESSION_VALUES.find((shared) => shared.wire === name)?.identity;
    if (location === undefined) continue;
    if (location.startsWith(MURA_PREFIX)) {
      mura[location.slice(MURA_PREFIX.length)] = value;
    } else if (location === 'nextPreserveKey') {
      // FW/1 increments the counter in CFML arithmetic, which the bridge sends as text.
      const key = isSimple(value) ? Number(value) : Number.NaN;
      if (Number.isSafeInteger(key) && key > 0) patch[location] = key;
    } else if (location === 'moduleTopIds') {
      // The bridge sends every module top legacy holds, and identity replaces the stored set with it.
      const tops = typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
      if (tops.length > 0 && tops.every(([, topId]) => isSimple(topId))) {
        patch[location] = Object.fromEntries(tops.map(([key, topId]) => [key, String(topId)]));
      }
    } else if (isSimple(value)) {
      patch[location] = String(value);
    }
  }
  if (Object.keys(mura).length > 0) patch.mura = mura;
  return patch as SessionAdminState;
}

/**
 * The bases of exported `mura` structs by `mura` key, against which identity stores only legacy's changes; undefined when
 * none has one. Top-level values, the module tops included, are stored whole.
 */
function muraBasesOf(exported: readonly ExportedValue[]): MuraBases | undefined {
  const bases: MuraBases = {};
  for (const { name, base } of exported) {
    const location = SHARED_SESSION_VALUES.find((shared) => shared.wire === name)?.identity;
    if (base !== undefined && location?.startsWith(MURA_PREFIX) === true) bases[location.slice(MURA_PREFIX.length)] = base;
  }
  return Object.keys(bases).length === 0 ? undefined : bases;
}

/** Creates the carry over identity's stored admin state, the bridge's `op=carry` and `op=export`, and the jar. */
export function createSessionCarry(opts: SessionCarryOptions): SessionCarry {
  const { identity, bridge, jar } = opts;
  const clock = opts.clock ?? systemClock;

  /** The jar's legacy session with its live cookies; undefined when the jar names none or every cookie is deleted. */
  async function attachedLegacySession(sessionId: string): Promise<AttachedLegacySession | undefined> {
    const row = await jar.get(sessionId);
    // Without a known legacy session, ColdFusion starts one for the request, which no target route has written to.
    if (row === undefined || row.legacySessionId === null) return undefined;
    const cookies = liveCookies(row.cookies, clock.now());
    return Object.keys(cookies).length === 0 ? undefined : { legacySessionId: row.legacySessionId, cookies };
  }

  /** `send`'s result; undefined in legacy-primary when the cookies no longer attach the jar's legacy session. */
  async function unlessMismatched<T>(mode: SessionMode, send: () => Promise<T>): Promise<T | undefined> {
    try {
      return await send();
    } catch (error) {
      // Legacy-primary cookies that no longer attach the jar's session reach a session no target route wrote to.
      if (mode === 'legacy-primary' && isBridgeSessionMismatch(error)) return undefined;
      throw error;
    }
  }

  return {
    async beforeLegacy(sessionId, mode, call = {}) {
      const attached = await attachedLegacySession(sessionId);
      if (attached === undefined) return;
      // In legacy-primary legacy alone holds the session, so identity's absence leaves it as it is.
      const state = await unlessIdentityDown(mode, () => identity.adminState(sessionId));
      if (state === undefined) return;
      const values: CarriedValue[] = [];
      for (const shared of SHARED_SESSION_VALUES) {
        const value = storedValue(state, shared.identity);
        if (isCarriable(value)) values.push({ name: shared.wire, value, revision: revisionOf(value) });
      }
      if (values.length === 0) return;
      const { legacySessionId, cookies } = attached;
      await unlessMismatched(mode, () => bridge.carry(cookies, values, { legacySessionId, userAgent: call.userAgent }));
    },

    async afterLegacy(sessionId, mode, call = {}) {
      const attached = await attachedLegacySession(sessionId);
      if (attached === undefined) return;
      const { legacySessionId, cookies } = attached;
      const exported = await unlessMismatched(mode, () => bridge.export(cookies, { legacySessionId, userAgent: call.userAgent }));
      if (exported === undefined) return;
      const patch = adminStatePatch(exported.body.values);
      if (Object.keys(patch).length === 0) return;
      const bases = muraBasesOf(exported.body.values);
      // In legacy-primary legacy alone holds the session, so identity's absence leaves identity as it is.
      await unlessIdentityDown(mode, () => identity.importAdminState(sessionId, patch, bases));
    },
  };
}
