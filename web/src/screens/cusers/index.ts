// The carried cUsers actions for the screen registry (server-only).
import type { ScreenDefinition } from '../registry';
import { addToGroupAction } from './addtogroup';
import { advancedSearchScreen } from './advancedsearch';
import { advancedSearchToCsvAction } from './advancedsearchtocsv';
import { defaultAction } from './default';
import { downloadScreen } from './download';
import { downloadGroupMembersAction } from './downloadgroupmembers';
import { editAddressScreen } from './editaddress';
import { editGroupScreen } from './editgroup';
import { editGroupMembersScreen } from './editgroupmembers';
import { editUserScreen } from './edituser';
import { listScreen } from './list';
import { listUsersScreen } from './listusers';
import { loadExtendedAttributesScreen } from './loadextendedattributes';
import { removeFromGroupAction } from './removefromgroup';
import { routeAction } from './route';
import { searchScreen } from './search';
import { updateActions } from './update';
import { updateAddressAction } from './updateaddress';

// Each definition applies the cUsers `before()` gate and rc defaults itself. The withheld `update` and
// `updateaddress` variants are refused by the registry's not-built list before these are matched.
/** Every carried cUsers action and `update` variant. */
export const cusersScreens: readonly ScreenDefinition[] = Object.freeze([
  addToGroupAction,
  advancedSearchScreen,
  advancedSearchToCsvAction,
  defaultAction,
  downloadScreen,
  downloadGroupMembersAction,
  editAddressScreen,
  editGroupScreen,
  editGroupMembersScreen,
  editUserScreen,
  listScreen,
  listUsersScreen,
  loadExtendedAttributesScreen,
  removeFromGroupAction,
  routeAction,
  searchScreen,
  ...updateActions,
  updateAddressAction,
]);
