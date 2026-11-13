// The bare `ccomments.ajax` view and the moderation actions that answer with it (server-only).
import type { FragmentScreen, RawBody, RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { CCOMMENTS_OWNER, ccommentsGate, relayCommentsRaw, type CommentsRawAction } from './shared';

// The inventory carries `ccomments.ajax` as a view-only action: FW/1 renders the view behind the controller gate when
// it is requested on its own, so its route key needs a screen once its units move, like the edits that render it.
/** `cComments.ajax`: strategies-content's empty `ajax.cfm` fragment, status, content type and bytes unchanged. */
export const ccommentsAjax: FragmentScreen = Object.freeze({
  circuit: 'ccomments',
  action: 'ajax',
  mode: 'fragment',
  owner: CCOMMENTS_OWNER,
  gate: ccommentsGate,
  render: (ctx: ScreenContext): Promise<RawBody> => relayCommentsRaw(ctx, 'ajax'),
});

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
