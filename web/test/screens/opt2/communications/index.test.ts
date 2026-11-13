// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles, SYNTHETIC_ROLES } from '@opt2/platform/auth';
import { runGate } from '@/lib/access-gate';
import { communicationsActions, communicationsScreens } from '@/screens/opt2/communications';
import { noAccessUrl } from '@/screens/opt2/shared';
import { OPT2_NAV_MODULES } from '@/shell/nav';
import { adminS2Request, anonymousRequest } from '../../../helpers/admin-request';
import { useTestEnv } from '../../../helpers/env';
import { senderRequest } from './context';

const definitions = [
  ...communicationsScreens.map((def) => ({ kind: 'screen', slug: def.screen, def })),
  ...communicationsActions.map((def) => ({ kind: 'action', slug: def.action, def })),
];

const OTHER_SYNTHETIC_ROLES = SYNTHETIC_ROLES.filter((role) => role !== Roles.communicationsSender);

describe('communications registrations', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('registers the templates, sends and delivery-status screens and the two writes', () => {
    expect(communicationsScreens.map((def) => def.screen)).toEqual(['templates', 'sends', 'delivery-status']);
    expect(communicationsActions.map((def) => def.action)).toEqual(['save-template', 'send']);
    expect(Object.isFrozen(communicationsScreens)).toBe(true);
    expect(Object.isFrozen(communicationsActions)).toBe(true);
  });

  it.each(definitions)('declares the module, service and sender role on $kind $slug', ({ def }) => {
    expect(def).toMatchObject({ module: 'communications', service: 'communications' });
    expect(def.roles).toEqual([Roles.communicationsSender]);
    expect(Object.isFrozen(def)).toBe(true);
  });

  it('serves the OPT-2 nav landing screen with the roles the nav shows it to', () => {
    const entry = OPT2_NAV_MODULES.find((candidate) => candidate.module === 'communications');
    const landing = communicationsScreens.find((def) => def.screen === entry?.screen);

    expect(landing?.roles).toEqual(entry?.roles);
  });

  it.each(definitions)('lets a communications sender through on $kind $slug', async ({ def }) => {
    await expect(runGate(senderRequest(), def.gate)).resolves.toEqual({ kind: 'allow' });
  });

  it.each(definitions.flatMap((entry) => OTHER_SYNTHETIC_ROLES.map((role) => ({ ...entry, role }))))(
    'sends $role to no-access on $kind $slug',
    async ({ def, role }) => {
      await expect(runGate(senderRequest({}, role), def.gate)).resolves.toEqual({
        kind: 'redirect',
        location: noAccessUrl(),
      });
    },
  );

  it.each(definitions)('gives an S2 admin no implicit access to $kind $slug', async ({ def }) => {
    await expect(runGate(adminS2Request(), def.gate)).resolves.toEqual({ kind: 'redirect', location: noAccessUrl() });
  });

  it.each(definitions)('sends an anonymous user to the login form from $kind $slug', async ({ def }) => {
    const decision = await runGate(anonymousRequest(), def.gate);

    expect(decision.kind).toBe('redirect');
    expect(decision.kind === 'redirect' ? decision.location : '').toMatch(/muraAction=cLogin\.main&returnURL=/);
  });
});
