// The values the custom server and the bundled app share through globalThis.
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import {
  awaitBoot,
  claimRequestLine,
  currentRequestScope,
  installRequestScope,
  signalBooted,
  type RequestScope,
} from '@/server/shared';

describe('boot handshake', () => {
  it('resolves the installed handshake once boot signals it', async () => {
    let resolved = false;
    const booted = awaitBoot().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    signalBooted();

    await booted;
    expect(resolved).toBe(true);
  });
});

describe('request scope', () => {
  it('reads the scope of the running request, and none outside one', () => {
    const storage = new AsyncLocalStorage<RequestScope>();
    installRequestScope(storage);
    const scope: RequestScope = { pipeline: false, logged: false };

    expect(storage.run(scope, () => currentRequestScope())).toBe(scope);
    expect(currentRequestScope()).toBeUndefined();
  });

  it("grants the request's line to its first claimant only", () => {
    const scope: RequestScope = { pipeline: false, logged: false };

    expect([claimRequestLine(scope), claimRequestLine(scope), claimRequestLine(scope)]).toEqual([true, false, false]);
    expect(scope.logged).toBe(true);
  });
});
