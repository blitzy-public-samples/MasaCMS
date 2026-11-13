// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
// The OPT-2 umbrella the screen registry registers: its module barrels, nav links, contract roles and gates.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNTHETIC_ROLES, type Role } from '@opt2/platform/auth';
import { runGate } from '@/lib/access-gate';
import type { Opt2ActionDefinition, Opt2Module, Opt2ScreenDefinition } from '@/screens/registry';
import { opt2Actions, opt2Screens } from '@/screens/opt2';
import { communicationsActions, communicationsScreens } from '@/screens/opt2/communications';
import { esignatureActions, esignatureScreens } from '@/screens/opt2/e-signature';
import { financeActions, financeScreens } from '@/screens/opt2/finance';
import { reportingActions, reportingScreens } from '@/screens/opt2/reporting';
import { noAccessUrl } from '@/screens/opt2/shared';
import { surveysActions, surveysScreens } from '@/screens/opt2/surveys';
import { timesheetsActions, timesheetsScreens } from '@/screens/opt2/timesheets';
import { OPT2_NAV_MODULES } from '@/shell/nav';
import { adminS2Request, anonymousRequest, opt2RoleRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

/** Each synthetic module's barrel, in the OPT-2 nav's order. */
const BARRELS: ReadonlyArray<{
  readonly module: Opt2Module;
  readonly screens: readonly Opt2ScreenDefinition[];
  readonly actions: readonly Opt2ActionDefinition[];
}> = [
  { module: 'timesheets', screens: timesheetsScreens, actions: timesheetsActions },
  { module: 'finance', screens: financeScreens, actions: financeActions },
  { module: 'e-signature', screens: esignatureScreens, actions: esignatureActions },
  { module: 'reporting', screens: reportingScreens, actions: reportingActions },
  { module: 'surveys', screens: surveysScreens, actions: surveysActions },
  { module: 'communications', screens: communicationsScreens, actions: communicationsActions },
];

/** Roles the `/v1/` operations of `service` require, from the `x-opt2-requires` lists of its OpenAPI contract. */
function contractRoles(service: string): ReadonlySet<string> {
  const contract = new URL(`../../../../services/${service}/contracts/openapi.yaml`, import.meta.url);
  const roles = new Set<string>();
  let path = '';
  let listing = false;
  for (const line of readFileSync(contract, 'utf8').split('\n')) {
    path = /^ {2}(\/\S*):\s*$/.exec(line)?.[1] ?? path;
    const item = listing ? /^\s+- (\S+)\s*$/.exec(line)?.[1] : undefined;
    if (item !== undefined) {
      if (path.startsWith('/v1/')) roles.add(item);
      continue;
    }
    listing = /^\s+x-opt2-requires:\s*$/.test(line);
  }
  return roles;
}

const definitions = [
  ...opt2Screens.map((def) => ({ key: `screen ${def.module}/${def.screen}`, def, run: [def.load, def.render] })),
  ...opt2Actions.map((def) => ({ key: `action ${def.module}/${def.action}`, def, run: [def.submit] })),
];

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('OPT-2 umbrella', () => {
  it('registers exactly the six module barrels, in the nav order, frozen', () => {
    const expectedScreens = BARRELS.flatMap(({ screens }) => screens);
    const expectedActions = BARRELS.flatMap(({ actions }) => actions);

    expect(BARRELS.map(({ module }) => module)).toEqual(OPT2_NAV_MODULES.map(({ module }) => module));
    expect(opt2Screens).toHaveLength(expectedScreens.length);
    expect(opt2Screens.every((def, index) => def === expectedScreens[index])).toBe(true);
    expect(opt2Actions).toHaveLength(expectedActions.length);
    expect(opt2Actions.every((def, index) => def === expectedActions[index])).toBe(true);
    expect(Object.isFrozen(opt2Screens)).toBe(true);
    expect(Object.isFrozen(opt2Actions)).toBe(true);
  });

  it('keys every screen and every action once by its lower-case module and slug', () => {
    const screenKeys = opt2Screens.map(({ module, screen }) => `${module}/${screen}`);
    const actionKeys = opt2Actions.map(({ module, action }) => `${module}/${action}`);

    for (const keys of [screenKeys, actionKeys]) {
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.filter((key) => key !== key.toLowerCase())).toEqual([]);
    }
  });

  it.each(OPT2_NAV_MODULES)('links the $label nav entry to a registered screen of its module', (entry) => {
    const landing = opt2Screens.find(({ module, screen }) => module === entry.module && screen === entry.screen);
    const moduleScreens = opt2Screens.filter(({ module }) => module === entry.module);

    expect(landing).toBeDefined();
    expect((landing?.roles ?? []).filter((role) => !entry.roles.includes(role))).toEqual([]);
    expect(entry.roles.filter((role) => !moduleScreens.some(({ roles }) => roles.includes(role)))).toEqual([]);
  });

  it.each(OPT2_NAV_MODULES)('admits every role the $label nav entry is shown to at its landing', async (entry) => {
    const landing = opt2Screens.find(({ module, screen }) => module === entry.module && screen === entry.screen);

    expect(landing).toBeDefined();
    for (const role of entry.roles) {
      await expect(runGate(opt2RoleRequest(role as Role), landing?.gate), role).resolves.toEqual({ kind: 'allow' });
    }
  });

  it.each(definitions)('owns $key by its module service under contract roles', ({ def, run }) => {
    const granted = contractRoles(def.service);

    expect(def.service).toBe(def.module);
    expect(def.roles.length).toBeGreaterThan(0);
    expect(def.roles.filter((role) => !granted.has(role) || !SYNTHETIC_ROLES.includes(role))).toEqual([]);
    expect(run.every((fn) => typeof fn === 'function')).toBe(true);
  });

  it.each(definitions.filter(({ def }) => def.gate !== undefined))(
    'admits only its roles to $key, sending S2 and other roles to no-access',
    async ({ def }) => {
      const denied = { kind: 'redirect', location: noAccessUrl() };
      const anonymous = await runGate(anonymousRequest(), def.gate);

      expect(anonymous.kind === 'redirect' ? anonymous.location : anonymous.kind).toMatch(/muraAction=cLogin\.main&/);
      await expect(runGate(adminS2Request(), def.gate)).resolves.toEqual(denied);
      for (const role of SYNTHETIC_ROLES) {
        const expected = def.roles.includes(role) ? { kind: 'allow' } : denied;
        await expect(runGate(opt2RoleRequest(role), def.gate), role).resolves.toEqual(expected);
      }
    },
  );
});
