// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
// The timesheets module's registrations: slugs the OPT-2 nav and the golden catalogue name, roles, service and gates.
import { describe, expect, it, vi } from 'vitest';
import { timesheetsActions, timesheetsScreens } from '@/screens/opt2/timesheets';
import { OPT2_NAV_MODULES } from '@/shell/nav';

// The registry loads every circuit's screens; this module imports only its types.
vi.mock('@/screens/registry', () => ({}));

describe('timesheets registrations', () => {
  const nav = OPT2_NAV_MODULES.find(({ module }) => module === 'timesheets');

  it('registers the nav entry screen, the sheet detail and the day action', () => {
    expect(nav).toBeDefined();
    expect(timesheetsScreens.map(({ module, screen }) => `${module}/${screen}`)).toEqual([
      `timesheets/${nav?.screen}`,
      'timesheets/sheet',
    ]);
    expect(timesheetsActions.map(({ module, action }) => `${module}/${action}`)).toEqual(['timesheets/day-action']);
  });

  it('owns every definition by timesheets behind a gate over the nav entry roles', () => {
    for (const def of [...timesheetsScreens, ...timesheetsActions]) {
      expect(def.service).toBe('timesheets');
      expect([...def.roles].sort()).toEqual([...(nav?.roles ?? [])].sort());
      expect(def.gate).toBeTypeOf('function');
    }
  });

  it('freezes what it exports', () => {
    expect(Object.isFrozen(timesheetsScreens)).toBe(true);
    expect(Object.isFrozen(timesheetsActions)).toBe(true);
    expect([...timesheetsScreens, ...timesheetsActions].every((def) => Object.isFrozen(def))).toBe(true);
  });
});
