// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
// The e-signature barrel: its screens and actions, the contract roles they declare and the OPT-2 nav entry.
import { describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { esignatureActions, esignatureScreens } from '@/screens/opt2/e-signature';
import { CREATE_ROLES, LIST_ROLES, requestsScreen } from '@/screens/opt2/e-signature/requests';
import { OPT2_NAV_MODULES } from '@/shell/nav';

const SIGNER = Roles.esignatureSigner;
const AUDITOR = Roles.esignatureAuditor;

describe('e-signature barrel', () => {
  // Each slug's roles are the x-opt2-requires of the v1 operations behind it in the e-signature contract; the requests
  // landing lists for signers and leads auditors by request id to the request, audit and verify reads.
  it.each<[string, readonly string[]]>([
    ['requests', [SIGNER, AUDITOR]],
    ['request', [SIGNER, AUDITOR]],
    ['audit', [SIGNER, AUDITOR]],
    ['verify', [SIGNER, AUDITOR]],
  ])('registers screen %s with roles %j behind a gate', (screen, roles) => {
    const def = esignatureScreens.find((candidate) => candidate.screen === screen);
    expect(def).toMatchObject({ module: 'e-signature', service: 'e-signature', roles });
    expect(typeof def?.gate).toBe('function');
  });

  it.each<[string, readonly string[]]>([
    ['create-request', [SIGNER]],
    ['sign', [SIGNER]],
    ['verify', [SIGNER, AUDITOR]],
  ])('registers action %s with roles %j behind a gate', (action, roles) => {
    const def = esignatureActions.find((candidate) => candidate.action === action);
    expect(def).toMatchObject({ module: 'e-signature', service: 'e-signature', roles });
    expect(typeof def?.gate).toBe('function');
  });

  it('registers the landing requests.ts defines, whose list and create roles are the contract operations\'', () => {
    expect(esignatureScreens.find((def) => def.screen === 'requests')).toBe(requestsScreen);
    expect([LIST_ROLES, CREATE_ROLES]).toEqual([[SIGNER], [SIGNER]]);
  });

  it('registers each slug once, lower-case', () => {
    const slugs = [...esignatureScreens.map((def) => `screen:${def.screen}`), ...esignatureActions.map((def) => `action:${def.action}`)];
    expect(slugs).toEqual([
      'screen:requests',
      'screen:request',
      'screen:audit',
      'screen:verify',
      'action:create-request',
      'action:sign',
      'action:verify',
    ]);
    expect(slugs.every((slug) => slug === slug.toLowerCase())).toBe(true);
  });

  it('serves the OPT-2 nav entry of e-signature', () => {
    const entry = OPT2_NAV_MODULES.find((candidate) => candidate.module === 'e-signature');
    expect(entry?.screen).toBe('requests');
    expect(esignatureScreens.map((def) => def.screen)).toContain(entry?.screen);
    // Every role the nav shows the entry to may open the screen it links to.
    const landing = esignatureScreens.find((def) => def.screen === entry?.screen);
    expect(entry?.roles).toEqual([SIGNER, AUDITOR]);
    for (const role of entry?.roles ?? []) expect(landing?.roles).toContain(role);
  });
});
