// `cArch.scaffold`: the Custom Entities scaffolder page of `admin/core/views/carch/scaffold.cfm` (server-only).
import type { ShellView } from '@/shell/document';
import type { PageScreen, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { scaffold } from './partials/scaffold';

/** carch before() defaults, then the view, which carch.list also includes as its Custom Entities tab. */
function renderScaffold(ctx: ScreenContext): ShellView {
  ctx.req = applyCarchDefaults(ctx.req);
  return { body: scaffold(ctx, { siteId: ctx.req.rc.siteid ?? '' }) };
}

/** `cArch.scaffold`: view-only page behind the carch `before()` gate; it reads nothing from a service. */
export const scaffoldScreen: PageScreen<undefined> = Object.freeze({
  circuit: 'carch',
  action: 'scaffold',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  render: renderScaffold,
});
