// The ccomments moderation actions that answer with the bare `ccomments.ajax` view (server-only).
import type { FragmentScreen, RawBody, ScreenContext } from '../registry';
import { CCOMMENTS_OWNER, ccommentsGate, relayCommentsRaw } from './shared';

/** `cComments.bulkEdit`: the `bulkedit` action over the `ckupdate` comments, then strategies-content's ajax body. */
export const ccommentsBulkEdit: FragmentScreen<undefined> = Object.freeze({
  circuit: 'ccomments',
  action: 'bulkedit',
  mode: 'fragment',
  owner: CCOMMENTS_OWNER,
  gate: ccommentsGate,
  render: (ctx: ScreenContext): Promise<RawBody> => relayCommentsRaw(ctx, 'bulkedit'),
});

/** `cComments.singleEdit`: the `updateaction` on `commentid`, then strategies-content's ajax body. */
export const ccommentsSingleEdit: FragmentScreen<undefined> = Object.freeze({
  circuit: 'ccomments',
  action: 'singleedit',
  mode: 'fragment',
  owner: CCOMMENTS_OWNER,
  gate: ccommentsGate,
  render: (ctx: ScreenContext): Promise<RawBody> => relayCommentsRaw(ctx, 'singleedit'),
});
