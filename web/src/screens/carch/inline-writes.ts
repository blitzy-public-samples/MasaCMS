// The carch actions that write, then abort with a bare body: quick edit, copy info and unlocks (server-only).
import type { JsonScreen, RawBody, ScreenContext, ScreenDefinition } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { relayCarchRaw, type CarchRawAction } from './service';

/** The bare body an inline write answers with, for the request as carch before() leaves it. */
type InlineWrite = (ctx: ScreenContext) => Promise<RawBody>;

/** strategies-content's legacy bytes for `action`, relayed as POST when the request carried a body, else as GET. */
const relayed =
  (action: CarchRawAction): InlineWrite =>
  (ctx) =>
    relayCarchRaw(ctx, action, ctx.body === undefined ? 'GET' : 'POST');

// carch.copy is not registered: it writes the decision-list table tcontenteventreminders, so it is withheld on legacy.
// savecopyinfo applies no session effects: the contract returns none, and the copy state is strategies-content's.
/** The inline write of each lower-case carch action. */
const INLINE_WRITES: Readonly<Record<string, InlineWrite>> = Object.freeze({
  savequickedit: relayed('savequickedit'),
  savecopyinfo: relayed('savecopyinfo'),
  unlockfile: relayed('unlockfile'),
  unlocknode: relayed('unlocknode'),
});

/** carch writes that abort with a bare body, served in JSON mode after the carch before() defaults. */
export const inlineWriteScreens: readonly ScreenDefinition[] = Object.freeze(
  Object.entries(INLINE_WRITES).map(
    ([action, write]): JsonScreen<undefined> =>
      Object.freeze({
        circuit: 'carch',
        action,
        owner: CARCH_OWNER,
        mode: 'json',
        gate: carchGate,
        json: async (ctx: ScreenContext): Promise<RawBody> => {
          ctx.req = applyCarchDefaults(ctx.req);
          return write(ctx);
        },
      }),
  ),
);
