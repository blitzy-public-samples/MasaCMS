// The `cUsers.default` action: FW/1's redirect to the cUsers group list of the request's site (server-only).
import { esapiUrlEncode } from '@opt2/platform/legacy-compat';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { cusersGate, normaliseCusersRc } from './gate';

/** `fw.redirect(action='cUsers.list', append='siteid', path='./')` over the context `before()` leaves. */
async function submitDefault({ req }: ScreenContext): Promise<SubmitResult> {
  // A result's `append` reads the request's rc, not the normalised one, so the `before()` siteid is appended here,
  // encoded and named exactly as FW/1 appends it.
  const { siteid } = normaliseCusersRc(req);
  return { kind: 'redirect', action: 'cUsers.list', path: './', queryString: `siteid=${esapiUrlEncode(siteid)}` };
}

/** The `cUsers.default` admin action. */
export const defaultAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'default',
  owner: 'people',
  mode: 'redirect',
  gate: cusersGate,
  submit: submitDefault,
});
