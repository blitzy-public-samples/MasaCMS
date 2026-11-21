// Process-wide values the custom server (loaded natively) and the bundled app share: the version, the boot handshake
// and the request scope. Bundling gives each layer its own copy of this module, so the slots live on globalThis.
import type { AsyncLocalStorage } from 'node:async_hooks';

/** Version written on every web log line and span resource; matches `web/package.json`. */
export const WEB_VERSION = '1.0.0';

/** Per-request state the custom server opens and the app's request logging marks. */
export interface RequestScope {
  /** Set when the admin pipeline took the request; it writes the request's line once it completes. */
  pipeline: boolean;
  /** Set once a writer claimed the request's log line through {@link claimRequestLine}. */
  logged: boolean;
}

/** Claims the request's one log line: true for the first writer, false for every later one. */
export function claimRequestLine(scope: RequestScope): boolean {
  if (scope.logged) return false;
  scope.logged = true;
  return true;
}

const BOOTED = Symbol.for('opt2.web.booted');
const REQUEST_SCOPE = Symbol.for('opt2.web.requestScope');

interface Slots {
  [BOOTED]?: () => void;
  [REQUEST_SCOPE]?: AsyncLocalStorage<RequestScope>;
}

const slots = globalThis as typeof globalThis & Slots;

/** Installs the boot handshake; the promise resolves when the app's start-up hook calls {@link signalBooted}. */
export function awaitBoot(): Promise<void> {
  return new Promise((resolve) => {
    slots[BOOTED] = resolve;
  });
}

/** Resolves the installed boot handshake; a no-op under `next start`, which installs none. */
export function signalBooted(): void {
  slots[BOOTED]?.();
}

/** Makes `storage` the request scope {@link currentRequestScope} reads. */
export function installRequestScope(storage: AsyncLocalStorage<RequestScope>): void {
  slots[REQUEST_SCOPE] = storage;
}

/** The scope of the request being handled; undefined outside the custom server. */
export function currentRequestScope(): RequestScope | undefined {
  return slots[REQUEST_SCOPE]?.getStore();
}
