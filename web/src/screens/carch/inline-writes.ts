// The carch actions that write, then abort with a bare body: quick edit, copy info, unlocks and object params (server-only).
import { LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import type { JsonScreen, RawBody, ScreenContext, ScreenDefinition } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { carchRawRedirect, carchWrite, relayCarchRaw, type CarchRawAction, type CarchWriteResult } from './service';

/** The bare body an inline write answers with, for the request as carch before() leaves it. */
type InlineWrite = (ctx: ScreenContext) => Promise<RawBody>;

/** An aborted action's answer: an empty 200 under ACF's HTML content type. */
const ABORTED: RawBody = Object.freeze({ status: 200, contentType: LEGACY_HTML_CONTENT_TYPE, body: '' });

/** strategies-content's legacy bytes for `action`, relayed as POST when the request carried a body, else as GET. */
const relayed =
  (action: CarchRawAction): InlineWrite =>
  (ctx) =>
    relayCarchRaw(ctx, action, ctx.body === undefined ? 'GET' : 'POST');

/** `data[name]` when it is a string, the key matched case-insensitively as a CFML struct key. */
function dataText(data: CarchWriteResult['data'], name: string): string | undefined {
  const key = Object.keys(data ?? {}).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : data?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * carch.updateObjectParams: posts every rc field to updateObjectParams, then writes the view's
 * `{contentid:'…',contenthistid:'…'}` literal for the version in the result's `data`, or nothing where legacy aborts.
 * @throws Error For a 400, which legacy answers with a ColdFusion error.
 */
async function updateObjectParams(ctx: ScreenContext): Promise<RawBody> {
  // loadBy an empty contentHistID gives a new bean, on which the controller aborts before any write.
  if (ctx.req.rc.contenthistid === '') return ABORTED;
  const outcome = await carchWrite(ctx, 'updateobjectparams');
  if (outcome.kind === 'redirect') return carchRawRedirect(outcome.location);
  if (outcome.kind === 'rejected') {
    // AdminNotFound is the unknown version, on which legacy aborts.
    if (outcome.status === 404) return ABORTED;
    throw new Error(`strategies-content rejected carch.updateobjectparams with HTTP ${String(outcome.status)}`);
  }
  // The service returns no version data on the branches legacy aborts on (no author or editor verdict).
  const contentId = dataText(outcome.data.data, 'contentid');
  const contentHistId = dataText(outcome.data.data, 'contenthistid');
  if (contentId === undefined || contentHistId === undefined) return ABORTED;
  // ACF writes the newline between </cfoutput> and <cfabort> as one trailing space.
  const body = `{contentid:'${contentId}',contenthistid:'${contentHistId}'} `;
  return { status: 200, contentType: LEGACY_HTML_CONTENT_TYPE, body };
}

// carch.copy is not registered: its write set spans identity and strategies-content, so it is withheld on legacy.
// savecopyinfo applies no session effects: the contract returns none, and the copy state is strategies-content's.
/** The carried inline write of each lower-case carch action. */
const INLINE_WRITES: Readonly<Record<string, InlineWrite>> = Object.freeze({
  savequickedit: relayed('savequickedit'),
  savecopyinfo: relayed('savecopyinfo'),
  unlockfile: relayed('unlockfile'),
  unlocknode: relayed('unlocknode'),
  updateobjectparams: updateObjectParams,
});

/** Carried carch writes that abort with a bare body, served in JSON mode after the carch before() defaults. */
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
