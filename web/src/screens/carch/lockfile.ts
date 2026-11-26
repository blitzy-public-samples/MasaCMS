// The `cArch.lockFile` action: strategies-content locks the file, then legacy's download redirect or empty abort.
import type { JsonScreen, RawBody, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { relayCarchRaw } from './service';

/** `cArch.lockFile`: the service's 302 to the `/_api/render/file` attachment, or its empty 200, relayed unchanged. */
export const lockfileScreen: JsonScreen = Object.freeze({
  circuit: 'carch',
  action: 'lockfile',
  // Inventoried as json, so the raw handler serves it: the service builds the lock and the download `Location`, and
  // web relays its answer as received rather than posting a write and rebuilding the redirect.
  mode: 'json',
  owner: CARCH_OWNER,
  gate: carchGate,
  async json(ctx: ScreenContext): Promise<RawBody> {
    // before() runs ahead of the action; the handler persists its session writes from the request left on `ctx`.
    ctx.req = applyCarchDefaults(ctx.req);
    // Only a post carries a body. The rc, CSRF pair included, travels unchanged; the service validates the token.
    return relayCarchRaw(ctx, 'lockfile', ctx.body === undefined ? 'GET' : 'POST', { rc: ctx.req.rc });
  },
});
