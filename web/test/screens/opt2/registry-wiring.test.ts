// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
// The module-level screen registry over the real OPT-2 umbrella: the lookups the OPT-2 page and action adapters make.
import { describe, expect, it } from 'vitest';
import { opt2Actions, opt2Screens } from '@/screens/opt2';
import { allOpt2Actions, allOpt2Screens, findOpt2Action, findOpt2Screen } from '@/screens/registry';

describe('screen registry OPT-2 registrations', () => {
  it('registers the umbrella screens and actions as the umbrella orders them', () => {
    expect(allOpt2Screens()).toHaveLength(opt2Screens.length);
    expect(allOpt2Screens().every((def, index) => def === opt2Screens[index])).toBe(true);
    expect(allOpt2Actions()).toHaveLength(opt2Actions.length);
    expect(allOpt2Actions().every((def, index) => def === opt2Actions[index])).toBe(true);
  });

  it.each(opt2Screens.map((def) => ({ key: `${def.module}/${def.screen}`, def })))(
    'serves screen $key in any case',
    ({ def }) => {
      expect(findOpt2Screen(def.module, def.screen)).toBe(def);
      expect(findOpt2Screen(def.module.toUpperCase(), def.screen.toUpperCase())).toBe(def);
    },
  );

  it.each(opt2Actions.map((def) => ({ key: `${def.module}/${def.action}`, def })))(
    'serves action $key in any case',
    ({ def }) => {
      expect(findOpt2Action(def.module, def.action)).toBe(def);
      expect(findOpt2Action(def.module.toUpperCase(), def.action.toUpperCase())).toBe(def);
    },
  );

  it('keeps screen and action slugs apart and serves no unregistered module', () => {
    expect(findOpt2Screen('timesheets', 'day-action')).toBeUndefined();
    expect(findOpt2Action('timesheets', 'sheets')).toBeUndefined();
    expect(findOpt2Screen('stub', 'sheets')).toBeUndefined();
  });
});
