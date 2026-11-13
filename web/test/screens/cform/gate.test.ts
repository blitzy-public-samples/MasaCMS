// cform before(): the Site Manager and Forms module gate of admin/core/controllers/cform.cfc, and the registered actions.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { runGate, secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { cformGate, cformScreens } from '@/screens/cform';
import type { ScreenDefinition, ScreenMode } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  buildTestAdminRequest,
  editorRequest,
  siteAdminRequest,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

const M000 = '00000000000000000000000000000000000';
const M004 = '00000000000000000000000000000000004';
const SENTINEL: GateDecision = Object.freeze({ kind: 'redirect', location: './?muraAction=cLogin.main' });
const ALLOW: GateDecision = { kind: 'allow' };
const GETFORM = { circuit: 'cform', item: 'getform' } as const;

const REQUIRED_MODES: Readonly<Record<string, ScreenMode>> = {
  getdialog: 'fragment',
  getfieldtemplate: 'fragment',
  getform: 'json',
  getfield: 'json',
  getfieldtype: 'json',
  getdataset: 'json',
};

// Registered only where the inventory carries them.
const OPTIONAL_MODES: Readonly<Record<string, ScreenMode>> = { export: 'download', importform: 'page' };

let restore: () => void;
let secureSpy: Mock<() => GateDecision>;

beforeEach(() => {
  restore = useTestEnv();
  secureSpy = vi.fn(() => SENTINEL);
});

afterEach(() => {
  restore();
});

const gate = async (req: AdminRequest): Promise<GateDecision> => cformGate(req, { secure: secureSpy });

// makeAdminRequest derives modulePerm from the claims and takes no override, so the preset's member is replaced.
/** The S2 preset with `modulePerm` granting only `granted`, recording each module id it was asked. */
function s2Granting(granted: string): { req: AdminRequest; modulePerm: Mock<(moduleId: string) => boolean> } {
  const modulePerm = vi.fn((moduleId: string) => moduleId === granted);
  return { req: { ...adminS2Request(GETFORM), modulePerm }, modulePerm };
}

describe('cformGate', () => {
  it('allows s2', async () => {
    expect(await gate(adminS2Request(GETFORM))).toEqual(ALLOW);
    expect(secureSpy).not.toHaveBeenCalled();
  });

  it('allows a site admin on its own site', async () => {
    const req = siteAdminRequest('tenant-a', GETFORM);

    expect(req.rc['siteid']).toBe('tenant-a');
    expect(await gate(req)).toEqual(ALLOW);
    expect(secureSpy).not.toHaveBeenCalled();
  });

  it('secures anonymous', async () => {
    expect(await gate(anonymousRequest(GETFORM))).toBe(SENTINEL);
    expect(secureSpy).toHaveBeenCalledTimes(1);
    // runGate binds secure() to the request, so the gate passes nothing.
    expect(secureSpy).toHaveBeenCalledWith();
  });

  it('secures qa_editor, who lacks m:004', async () => {
    expect(await gate(editorRequest(GETFORM))).toBe(SENTINEL);
    expect(secureSpy).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string, string[][]]>([
    ['secures with m:000 only', M000, [[M000], [M004]]],
    ['secures with m:004 only', M004, [[M000]]],
  ])('%s', async (_label, granted, asked) => {
    const { req, modulePerm } = s2Granting(granted);

    expect(await gate(req)).toBe(SENTINEL);
    expect(modulePerm.mock.calls).toEqual(asked);
    expect(secureSpy).toHaveBeenCalledTimes(1);
  });

  it('binds to the token site, not rc.siteid', async () => {
    const req = siteAdminRequest('tenant-a', { ...GETFORM, rc: { siteid: 'tenant-b' } });

    expect(req.rc['siteid']).toBe('tenant-b');
    expect(await gate(req)).toEqual(ALLOW);
  });

  it.each<[string, 'siteAdmin' | 'qaEditor', string, GateDecision]>([
    ['allows a built site-admin request', 'siteAdmin', 'tenant-a', ALLOW],
    ['secures a built qa_editor request', 'qaEditor', 'default', SENTINEL],
  ])('%s', async (_label, user, siteid, expected) => {
    const req = await buildTestAdminRequest({ circuit: 'cform', action: 'getform', user, query: { siteid } });

    expect(await gate(req)).toEqual(expected);
  });

  it('sends anonymous to the login form through the real secure()', async () => {
    const req = anonymousRequest(GETFORM);

    expect(await cformGate(req, { secure: () => secure(req) })).toEqual({
      kind: 'redirect',
      location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main/),
    });
  });

  it('sends qa_editor back to the referrer through runGate', async () => {
    const referer = 'http://localhost/admin/?muraAction=cArch.list';
    const req = editorRequest({ ...GETFORM, headers: new Headers({ referer }) });

    expect(await runGate(req, cformGate)).toEqual({ kind: 'redirect', location: referer });
  });

  it('lets s2 through runGate', async () => {
    expect(await runGate(adminS2Request(GETFORM), cformGate)).toEqual(ALLOW);
  });
});

describe('cformScreens', () => {
  const modes = new Map(cformScreens.map((screen) => [screen.action, screen.mode]));

  it.each<[string, ScreenDefinition]>(cformScreens.map((screen) => [screen.action, screen]))(
    'registers %s for strategies-content behind cformGate',
    (_action, screen) => {
      expect(screen.circuit).toBe('cform');
      expect(screen.owner).toBe('strategies-content');
      expect(screen.gate).toBe(cformGate);
    },
  );

  it('registers each action once, and only known actions', () => {
    expect(modes.size).toBe(cformScreens.length);
    expect([...modes.keys()].filter((action) => !(action in REQUIRED_MODES || action in OPTIONAL_MODES))).toEqual([]);
  });

  it.each(Object.entries(REQUIRED_MODES))('serves %s as %s', (action, mode) => {
    expect(modes.get(action)).toBe(mode);
  });

  it.each(Object.entries(OPTIONAL_MODES))('serves %s, if registered, as %s', (action, mode) => {
    if (modes.has(action)) expect(modes.get(action)).toBe(mode);
  });
});
