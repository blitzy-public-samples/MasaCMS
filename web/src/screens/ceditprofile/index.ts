// The carried cEditProfile actions for the screen registry (server-only).
import type { ScreenDefinition } from '../registry';
import { editProfileScreen } from './edit';
import { updateProfileAction } from './update';

// The withheld `update` photo and extended-data variants are refused by the registry's not-built list.
/** `cEditProfile.edit` and the carried `cEditProfile.update`, each behind the cEditProfile `before()` gate. */
export const ceditprofileScreens: readonly ScreenDefinition[] = Object.freeze([editProfileScreen, updateProfileAction]);
