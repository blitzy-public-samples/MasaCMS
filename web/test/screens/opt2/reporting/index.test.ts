// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, expect, it } from 'vitest';
import { downloadAction, queueAction } from '@/screens/opt2/reporting/actions';
import { exportsScreen } from '@/screens/opt2/reporting/exports';
import { reportingActions, reportingScreens } from '@/screens/opt2/reporting';
import { OPT2_NAV_MODULES } from '@/shell/nav';

describe('reporting module registrations', () => {
  it('exports the export job list and its queue and download actions, frozen', () => {
    expect(reportingScreens).toEqual([exportsScreen]);
    expect(reportingActions).toEqual([queueAction, downloadAction]);
    expect(Object.isFrozen(reportingScreens)).toBe(true);
    expect(Object.isFrozen(reportingActions)).toBe(true);
  });

  it("registers the OPT-2 nav's reporting landing screen with the nav's roles", () => {
    const nav = OPT2_NAV_MODULES.find((entry) => entry.module === 'reporting');

    expect(nav).toBeDefined();
    expect(reportingScreens.find((def) => def.screen === nav?.screen)?.roles).toEqual(nav?.roles);
  });

  it('gates every definition and names each slug once, in lower case', () => {
    const slugs = [...reportingScreens.map((def) => def.screen), ...reportingActions.map((def) => def.action)];

    expect(slugs).toEqual(['exports', 'queue', 'download']);
    for (const def of [...reportingScreens, ...reportingActions]) {
      expect(def).toMatchObject({ module: 'reporting', service: 'reporting' });
      expect(typeof def.gate).toBe('function');
    }
  });
});
