// The ccomments moderation actions that answer with the bare `ccomments.ajax` view (server-only).
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { CCOMMENTS_OWNER, ccommentsGate, relayCommentsRaw, type CommentsRawAction } from './shared';

// The inventory records both edits as redirect-mode post actions, which the gateway sends to the post-action handler;
// their answer is the ajax view's bare body rather than a redirect.
/** A redirect-mode edit: strategies-content runs the write, then its ajax body is returned unchanged. */
function ajaxEdit(action: Extract<CommentsRawAction, 'bulkedit' | 'singleedit'>): RedirectScreen {
  return Object.freeze({
    circuit: 'ccomments',
    action,
    mode: 'redirect',
    owner: CCOMMENTS_OWNER,
    gate: ccommentsGate,
    submit: async (ctx: ScreenContext): Promise<SubmitResult> => ({
      kind: 'raw',
      response: await relayCommentsRaw(ctx, action),
    }),
  });
}

/** `cComments.bulkEdit`: the `bulkedit` action over the `ckupdate` comments, then strategies-content's ajax body. */
export const ccommentsBulkEdit: RedirectScreen = ajaxEdit('bulkedit');

/** `cComments.singleEdit`: the `updateaction` on `commentid`, then strategies-content's ajax body. */
export const ccommentsSingleEdit: RedirectScreen = ajaxEdit('singleedit');
