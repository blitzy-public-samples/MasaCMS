// The reproduced `clogin` circuit and the `home.redirect` admin home for the screen registry (server-only).
import type { ScreenDefinition } from '../registry';
import { homeRedirectScreen } from './home-redirect';
import { cloginLoginScreen } from './login';
import { cloginLogoutScreen } from './logout';
import { cloginMainScreen } from './main';

/** The login page, the login and logout actions, and the admin home redirect. */
export const cloginScreens: readonly ScreenDefinition[] = Object.freeze([
  cloginMainScreen,
  cloginLoginScreen,
  cloginLogoutScreen,
  homeRedirectScreen,
]);
