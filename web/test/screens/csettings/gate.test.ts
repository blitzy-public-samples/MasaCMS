// csettingsGate's use of the controller's secure(), S2 from the token, and requests the real admin builder makes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { runGate, secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { csettingsGate } from '@/screens/csettings';
import { SITE_IDS } from '../../fixtures/programs-sites/sites';
import {
  adminS2Request,
  anonymousRequest,
  buildTestAdminRequest,
  editorRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import type { WebTestSubjectKey } from '../../helpers/tokens';

type Preset = (partial?: AdminRequestPartial) => AdminRequest;
type Fields = Readonly<Record<string, string>>;

const ALLOW: GateDecision = { kind: 'allow' };

/** Role and membership values a caller might post, none of which a verified token carries. */
const ROLE_MARKERS: Fields = {
  s2: '1',
  isS2: 'true',
  memberships: 'S2',
  isSiteAdmin: 'true',
  roles: `${Roles.s2},${Roles.siteAdmin}`,
};

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

const gate = (req: AdminRequest): GateDecision | Promise<GateDecision> =>
  csettingsGate(req, { secure: () => secure(req) });

const tenantAAdmin: Preset = (partial) => siteAdminRequest(SITE_IDS.tenantA, partial);

/** `preset` on `csettings.<item>`, with `extra` laid over it. */
const reqFor = (preset: Preset, item: string, extra: AdminRequestPartial = {}): AdminRequest =>
  preset({ ...extra, circuit: 'csettings', item });

/** The real builder's request for `user` on `muraAction` as the browser cased it, posting `form` when given. */
function built(user: WebTestSubjectKey, muraAction: string, query: Fields, form?: Fields): Promise<AdminRequest> {
  const [circuit = '', action = ''] = muraAction.split('.');
  return buildTestAdminRequest({ circuit, action, query, form, user });
}

describe('csettingsGate', () => {
  describe('secure()', () => {
    it.each<[string, AdminRequest]>([
      ['S2 on siteCopy', reqFor(adminS2Request, 'siteCopy')],
      ['the tenant-a site admin on editsite', reqFor(tenantAAdmin, 'editsite', { rc: { siteid: SITE_IDS.tenantA } })],
    ])('is not called for %s', async (_label, req) => {
      const helper = vi.fn(() => secure(req));
      expect(await csettingsGate(req, { secure: helper })).toEqual(ALLOW);
      expect(helper).not.toHaveBeenCalled();
    });

    it.each<[string, AdminRequest]>([
      ['the tenant-a site admin on updatePluginVersion', reqFor(tenantAAdmin, 'updatePluginVersion')],
      ['the editor on editsite', reqFor(editorRequest, 'editsite', { rc: { siteid: SITE_IDS.default } })],
      ['anonymous on editsite', reqFor(anonymousRequest, 'editsite')],
    ])('answers once for %s', async (_label, req) => {
      const helper = vi.fn(() => secure(req));
      const decision = await csettingsGate(req, { secure: helper });
      expect(helper).toHaveBeenCalledTimes(1);
      expect(helper).toHaveBeenCalledWith();
      expect(decision).toBe(helper.mock.results[0]?.value);
    });
  });

  describe('S2', () => {
    it.each(['updatesite', 'exporthtml', 'siteCopy', 'editsite'])('allows S2 on %s for tenant-b', async (item) => {
      expect(await gate(reqFor(adminS2Request, item, { rc: { siteid: SITE_IDS.tenantB } }))).toEqual(ALLOW);
    });

    it.each(['list', 'editsite'])('allows the s2 claim without the s2 role on %s', async (item) => {
      const req = reqFor(editorRequest, item, { user: { s2: true }, rc: { siteid: SITE_IDS.default } });
      expect(req.roles).not.toContain(Roles.s2);
      expect(await gate(req)).toEqual(ALLOW);
    });
  });

  describe('over the admin request builder', () => {
    it.each(['cSettings.editPlugin', 'CSETTINGS.SITECOPY', 'csettings.sitecopyselect', 'cSettings.List'])(
      'secures the tenant-a site admin on %s',
      async (muraAction) => {
        const req = await built('siteAdmin', muraAction, { siteid: SITE_IDS.tenantA });
        expect(await runGate(req, csettingsGate)).toEqual({ kind: 'redirect', location: './' });
      },
    );

    it.each(['cSettings.editSite', 'CSETTINGS.UPDATESITE', 'cSettings.loadCustomImages'])(
      'allows the tenant-a site admin on %s',
      async (muraAction) => {
        const req = await built('siteAdmin', muraAction, { siteid: SITE_IDS.tenantA });
        expect(await runGate(req, csettingsGate)).toEqual(ALLOW);
      },
    );

    it.each<[string, WebTestSubjectKey, string, string]>([
      ['the editor on editSite', 'qaEditor', 'cSettings.editSite', SITE_IDS.default],
      ['the tenant-a site admin on list', 'siteAdmin', 'cSettings.list', SITE_IDS.tenantA],
    ])('ignores rc role markers for %s', async (_label, user, muraAction, siteid) => {
      const req = await built(user, muraAction, { siteid, ...ROLE_MARKERS }, ROLE_MARKERS);
      expect(req.rc['memberships']).toBe('S2');
      expect(req.isS2).toBe(false);
      const decision = await runGate(req, csettingsGate);
      expect(decision).toEqual(secure(req));
      expect(decision).toEqual({ kind: 'redirect', location: './' });
    });
  });
});
