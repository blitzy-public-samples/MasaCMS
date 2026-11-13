// `cEditProfile.update`: people saves the session user, then the home redirect or `update.cfm`'s edit view (server-only).
import { okBody } from '@/lib/gateway-client';
import { setSessionMuraValue } from '@/lib/request-context';
import type { PageControllerRedirect, PageRedirect, PageScreen, ScreenContext } from '../registry';
import {
  buildEditProfileView,
  ceditprofileGate,
  editProfileRc,
  renderEditProfile,
  type EditProfileView,
  type ProfileData,
} from './edit';

const SERVICE = 'people';

// The key and shape are those cUsers.update stores, whose module is outside this file's dependencies.
/** `session.mura` key of the retained bean of a failed save. */
const EDIT_BEAN_SESSION_KEY = 'editBean';

/** `session.mura.editBean` after a failed save: the bean of posted values and its errors. */
interface RetainedProfileBean {
  readonly userBean: ProfileData['user'] | undefined;
  readonly errors: ProfileData['errors'];
}

/** `fw.redirect(action="home.redirect", path="./")`. */
const HOME_REDIRECT: PageRedirect = Object.freeze({ kind: 'redirect', action: 'home.redirect', path: './' });

/** The failed save each controller step kept, read by `load` for the same request. */
const FAILED_SAVES = new WeakMap<ScreenContext, RetainedProfileBean>();

/**
 * `update()`: posts every rc field, the CSRF pair included, for people to validate under the default context and save
 * as the session user. A save clears `session.mura.editBean` and answers the home redirect; validation errors become
 * the session's edit bean and the view's data.
 * @throws TypeError When people wrote nothing and reports no errors (a rejected token): legacy's view then reads the
 * unset `rc.userBean`.
 * @throws GatewayDenialError When people answers 401 or 403; any other non-2xx answer throws `Error`.
 */
async function updateProfileStep(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
  const response = await ctx.gateway.people.call('post', '/v1/profile:update', { form: Object.entries(ctx.req.rc) });
  const { redirect, errors, userBean } = okBody(response, SERVICE, 'updateProfile');
  if (redirect !== undefined) {
    setSessionMuraValue(ctx.req, EDIT_BEAN_SESSION_KEY, undefined);
    return HOME_REDIRECT;
  }
  if (Object.keys(errors).length === 0) throw new TypeError('Element USERBEAN is undefined in RC.');
  const retained: RetainedProfileBean = { userBean, errors };
  setSessionMuraValue(ctx.req, EDIT_BEAN_SESSION_KEY, retained);
  FAILED_SAVES.set(ctx, retained);
  return undefined;
}

/**
 * `include edit.cfm` after a failed save: people's Edit Profile data with the save's bean and errors, for the user's own
 * site, which `update()` sets as `rc.siteid`.
 * @throws Error When the controller step has not run for `ctx`.
 * @throws GatewayDenialError When people or programs-sites refuses a read (401 or 403).
 */
async function loadFailedSaveView(ctx: ScreenContext): Promise<EditProfileView> {
  const failed = FAILED_SAVES.get(ctx);
  if (failed === undefined) throw new Error('cEditProfile.update loaded before its controller step ran');
  const stored = okBody(await ctx.gateway.people.call('get', '/v1/profile'), SERVICE, 'getProfile');
  const profile: ProfileData = { ...stored, user: failed.userBean ?? stored.user, errors: failed.errors, retained: true };
  return buildEditProfileView(ctx, profile, { rcSiteId: profile.user.SiteID, rc: editProfileRc(ctx.req) });
}

/** `cEditProfile.update` without a photo, owned by people, behind the cEditProfile `before()` gate. */
export const updateProfileAction: PageScreen<EditProfileView> = Object.freeze({
  circuit: 'ceditprofile',
  action: 'update',
  owner: 'people',
  // Inventoried as a page: the gateway folds the posted form into a page request, so the save is the controller step.
  mode: 'page',
  gate: ceditprofileGate,
  redirect: updateProfileStep,
  load: loadFailedSaveView,
  render: renderEditProfile,
});
