// The carried cEditProfile actions for the screen registry (server-only).
import type { ScreenDefinition } from '../registry';
import { editProfileScreen } from './edit';

// `update` is halted (EX-ROSTER-POOLMOVE), so the gateway keeps it on legacy and web registers no screen for it.
/** `cEditProfile.edit`, behind the cEditProfile `before()` gate. */
export const ceditprofileScreens: readonly ScreenDefinition[] = Object.freeze([editProfileScreen]);
