// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
// The finance barrel the OPT-2 umbrella registers: its screens, post actions and the nav entry they serve.
import { Roles } from '@opt2/platform/auth';
import { describe, expect, it } from 'vitest';
import { financeActions, financeScreens } from '@/screens/opt2/finance';
import { OPT2_NAV_MODULES } from '@/shell/nav';

const PREPARER = Roles.financePreparer;
const READERS = [PREPARER, Roles.financeApprover];

describe('finance barrel', () => {
  it('exports the record list and detail screens of the finance module, gated by the reader roles', () => {
    expect(financeScreens.map(({ screen }) => screen)).toEqual(['records', 'record']);
    for (const def of financeScreens) {
      expect([def.module, def.service, def.roles], def.screen).toEqual(['finance', 'finance', READERS]);
      expect(typeof def.gate, def.screen).toBe('function');
      expect(Object.isFrozen(def), def.screen).toBe(true);
    }
  });

  it('exports one post action per lifecycle button, edit, upload and download, each gated', () => {
    expect(financeActions.map(({ action }) => action)).toEqual([
      'submit',
      'resubmit',
      'approve',
      'reject',
      'edit',
      'upload',
      'download',
    ]);
    for (const def of financeActions) {
      const roles = def.action === 'upload' ? [PREPARER] : READERS;
      expect([def.module, def.service, def.roles], def.action).toEqual(['finance', 'finance', roles]);
      expect(typeof def.gate, def.action).toBe('function');
      expect(Object.isFrozen(def), def.action).toBe(true);
    }
  });

  it('serves the OPT-2 nav Finance entry for the roles that see it', () => {
    const entry = OPT2_NAV_MODULES.find(({ module }) => module === 'finance');
    const landing = financeScreens.find(({ screen }) => screen === entry?.screen);

    expect(landing?.roles).toEqual(entry?.roles);
  });
});
