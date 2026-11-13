// `cFeed.edit`, also rendered by `cFeed.update`: the Local or Remote branch of `cfeed/edit.cfm` (server-only).
import { cfEq } from '@opt2/platform/legacy-compat';
import type { AdminRequest } from '@/lib/request-context';
import type { ShellView } from '@/shell/document';
import type { PageScreen, ScreenContext } from '../registry';
import { cfeedGate } from './before';
import { loadFeedEditModel, type FeedEditModel } from './edit-model';
import { renderFeedEditLocal } from './edit-local';
import { renderRemoteFeedEdit } from './edit-remote';
import { cfeedAjaxScripts } from './js';

/** Options of {@link renderFeedEdit}. */
export interface FeedEditOptions {
  /** `listLast(request.action, '.')`: `edit`, or `update` when a rejected save re-renders the form. */
  readonly fuseaction: string;
}

/**
 * Renders `edit.cfm` for the defaulted `req`: Local when `rc.type eq 'Local'`, else Remote, with `js.cfm`'s scripts.
 * @throws GatewayDenialError When identity refuses the collection's CSRF tokens (401 or 403).
 * @throws Error Where legacy fails rendering the branch.
 */
export async function renderFeedEdit(
  req: AdminRequest,
  ctx: ScreenContext,
  model: FeedEditModel,
  { fuseaction }: FeedEditOptions,
): Promise<ShellView> {
  const branch = cfEq(req.rc.type ?? '', 'Local')
    ? await renderFeedEditLocal(req, ctx, model, { fuseaction })
    : await renderRemoteFeedEdit(req, ctx, model, { fuseaction });
  return { ...branch, ajax: cfeedAjaxScripts() };
}

/** `cFeed.edit`: a collection's Local index or Remote feed form behind the cfeed `before()` gate. */
export const cfeedEditScreen: PageScreen<FeedEditModel> = Object.freeze({
  circuit: 'cfeed',
  action: 'edit',
  mode: 'page',
  owner: 'strategies-content',
  gate: cfeedGate,
  secondaryMenu: 'cfeed',
  // The loader replaces `ctx.req` with the defaulted request, which the view and the shell then read.
  load: (ctx: ScreenContext) => loadFeedEditModel(ctx.req, ctx),
  render: (ctx: ScreenContext, model: FeedEditModel) => renderFeedEdit(ctx.req, ctx, model, { fuseaction: 'edit' }),
});
