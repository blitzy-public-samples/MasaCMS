// The carried collection (cFeed) actions for the screen registry, each behind the controller `before()` (server-only).
import type { FragmentScreen, ScreenContext, ScreenDefinition } from '../registry';
import { applyCfeedDefaults } from './before';
import { cfeedEditScreen } from './edit';
import { cfeedListScreen } from './list';
import { cfeedLoadSiteScreen } from './loadsite';
import { cfeedSiteParentsScreen } from './siteparents';
import { cfeedUpdateScreen } from './update';

export { cfeedSecondaryMenu } from './secondary-menu';

// FW/1 runs `before()` ahead of the action's first step; the handler passes this one context on to the view and the
// shell, so they read the defaults too.
/** `ctx` with its request's rc given the cfeed `before()` defaults. */
function afterBefore(ctx: ScreenContext): ScreenContext {
  ctx.req = { ...ctx.req, rc: applyCfeedDefaults(ctx.req.rc) };
  return ctx;
}

/** `cFeed.loadSite`, whose relay forwards the rc as the `before()` defaults leave it. */
const loadSiteScreen: FragmentScreen = Object.freeze({
  ...cfeedLoadSiteScreen,
  render: (ctx: ScreenContext, data: unknown) => cfeedLoadSiteScreen.render(afterBefore(ctx), data),
});

// list, edit, siteparents and update apply the defaults in their own first step. import1 is halted and import2 is on
// the decision list, so the gateway keeps both on legacy and web registers no screen for either; js and the dsp_ views
// are partials, not actions.
/** The carried cFeed actions: the Collections list, the edit screen, their fragments and the save. */
export const cfeedScreens: readonly ScreenDefinition[] = Object.freeze([
  cfeedListScreen,
  cfeedEditScreen,
  loadSiteScreen,
  cfeedSiteParentsScreen,
  cfeedUpdateScreen,
]);
