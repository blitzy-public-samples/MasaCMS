// The carried collection (cFeed) actions for the screen registry, each behind the controller `before()` (server-only).
import type { FragmentScreen, PageScreen, ScreenContext, ScreenDefinition } from '../registry';
import { applyCfeedDefaults } from './before';
import { cfeedEditScreen } from './edit';
import { cfeedImport1Screen, loadCfeedImport1, type CfeedImport1Data } from './import1';
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

/** `cFeed.import1`, whose load runs after the `before()` defaults. */
const import1Screen: PageScreen<CfeedImport1Data> = Object.freeze({
  ...cfeedImport1Screen,
  load: (ctx: ScreenContext) => loadCfeedImport1(afterBefore(ctx)),
});

/** `cFeed.loadSite`, whose relay forwards the rc as the `before()` defaults leave it. */
const loadSiteScreen: FragmentScreen = Object.freeze({
  ...cfeedLoadSiteScreen,
  render: (ctx: ScreenContext, data: unknown) => cfeedLoadSiteScreen.render(afterBefore(ctx), data),
});

// list, edit, siteparents and update apply the defaults in their own first step. import2 is on the decision list, so
// the gateway keeps it on legacy and web registers no screen for it; js and the dsp_ views are partials, not actions.
/** The carried cFeed actions: the Collections list, the edit and import screens, their fragments and the save. */
export const cfeedScreens: readonly ScreenDefinition[] = Object.freeze([
  cfeedListScreen,
  cfeedEditScreen,
  import1Screen,
  loadSiteScreen,
  cfeedSiteParentsScreen,
  cfeedUpdateScreen,
]);
