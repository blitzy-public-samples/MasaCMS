// ccomments.loadcommentspage: the comment-thread window fragment, relayed from strategies-content (server-only).
import type { FragmentScreen, RawBody, ScreenContext } from '../registry';
import { CCOMMENTS_OWNER, ccommentsGate, relayCommentsRaw } from './shared';

/** `ccomments.loadcommentspage`: the service's `#commentsPage` fragment, status and content type, bytes unchanged. */
export const ccommentsLoadCommentsPage: FragmentScreen = Object.freeze({
  circuit: 'ccomments',
  action: 'loadcommentspage',
  mode: 'fragment',
  owner: CCOMMENTS_OWNER,
  gate: ccommentsGate,
  render(ctx: ScreenContext): Promise<RawBody> {
    return relayCommentsRaw(ctx, 'loadcommentspage');
  },
});
