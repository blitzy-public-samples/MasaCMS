// ccomments.loadcomments: the comment search and list fragment, relayed from strategies-content (server-only).
import type { FragmentScreen, RawBody, ScreenContext } from '../registry';
import { CCOMMENTS_OWNER, ccommentsGate, relayCommentsRaw } from './shared';

/** `cComments.loadComments`: the service-rendered comment search and list fragment, status and bytes unchanged. */
export const ccommentsLoadComments: FragmentScreen = Object.freeze({
  circuit: 'ccomments',
  action: 'loadcomments',
  mode: 'fragment',
  owner: CCOMMENTS_OWNER,
  gate: ccommentsGate,
  render: (ctx: ScreenContext): Promise<RawBody> => relayCommentsRaw(ctx, 'loadcomments'),
});
