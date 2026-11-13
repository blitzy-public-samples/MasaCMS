// The carried cperm screens for the screen registry (server-only).
import type { ScreenDefinition } from '../registry';
import { cpermMain } from './main';
import { cpermModule } from './module';
import { cpermUpdateModule } from './updatemodule';

// cperm.update stays on legacy: it writes tpermissions (identity) and tapprovalassignments (strategies-content), so it
// is a withheld decision-list action with no target screen; findScreen leaves it unserved and the gateway keeps it.
/** The carried cperm actions, each identity-owned behind the cperm `before()` gate: main, module and updatemodule. */
export const cpermScreens: readonly ScreenDefinition[] = Object.freeze([cpermMain, cpermModule, cpermUpdateModule]);
