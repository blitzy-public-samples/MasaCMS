// cusers.cfc before() against legacy: the access gate (95-124) and the request-context defaults and scrubbing (91-169).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { cusersGate, isCusersAdmin, normaliseCusersRc, userPoolIdFor } from '@/screens/cusers/gate';
import { siteTenantA } from '../../fixtures/programs-sites/sites';
import { USER_IDS } from '../../fixtures/session';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

const USERS_MODULE = '00000000000000000000000000000000008';
const SITE_MODULE = '00000000000000000000000000000000000';
const ALLOW: GateDecision = { kind: 'allow' };

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

const gate = (req: AdminRequest): GateDecision | Promise<GateDecision> =>
  cusersGate(req, { secure: () => secure(req) });

/** qa_editor holding exactly `roles` on its token site, on `cusers.<item>`. */
const editorWith = (roles: readonly string[], partial: AdminRequestPartial = {}): AdminRequest =>
  makeAdminRequest({ circuit: 'cusers', item: 'list', ...partial, user: { roles: [...roles] } }, 'qaEditor');

const listOf = (req: (partial?: AdminRequestPartial) => AdminRequest): AdminRequest =>
  req({ circuit: 'cusers', item: 'list' });

describe('cusersGate', () => {
  it.each([
    ['S2', listOf(adminS2Request)],
    ['the private-pool Admin', siteAdminRequest('tenant-a', { circuit: 'cusers', item: 'list' })],
    ['Users and Site Manager module access', editorWith([Roles.systemUser, moduleRole(USERS_MODULE), moduleRole(SITE_MODULE)])],
  ])('allows %s', async (_who, req) => {
    expect(await gate(req)).toEqual(ALLOW);
  });

  it.each([
    ['Users module only', editorWith([Roles.systemUser, moduleRole(USERS_MODULE)])],
    ['Site Manager module only', editorWith([Roles.systemUser, moduleRole(SITE_MODULE)])],
    ['rc.s2 from a non-S2 user', editorWith([Roles.systemUser, moduleRole(SITE_MODULE)], { rc: { s2: '1' } })],
  ])('secures %s', async (_who, req) => {
    const decision = await gate(req);
    expect(decision).toEqual(secure(req));
    expect(decision).toEqual({ kind: 'redirect', location: './' });
  });

  it('secures anonymous to the login form', async () => {
    const req = anonymousRequest({ circuit: 'cusers', item: 'list' });
    const decision = await gate(req);
    expect(decision).toEqual(secure(req));
    expect(decision).toMatchObject({ location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main&returnURL=/) });
  });

  describe('loadExtendedAttributes', () => {
    const extendedAttributes = (roles: readonly string[], rc: Record<string, string>): AdminRequest =>
      editorWith(roles, { item: 'loadExtendedAttributes', rc });

    it('bypasses for the own baseID, compared case-insensitively', async () => {
      const req = extendedAttributes([Roles.systemUser], { baseid: editorRequest().session.mura.userID.toLowerCase() });
      expect(req.action).toBe('core:cusers.loadextendedattributes');
      expect(await gate(req)).toEqual(ALLOW);
    });

    it('bypasses for another baseID with Users module access on the site', async () => {
      expect(await gate(extendedAttributes([Roles.systemUser, moduleRole(USERS_MODULE)], { baseID: USER_IDS.admin }))).toEqual(
        ALLOW,
      );
    });

    it('bypasses for another baseID of the private-pool Admin', async () => {
      const req = siteAdminRequest('tenant-a', {
        circuit: 'cusers',
        item: 'loadExtendedAttributes',
        rc: { baseID: USER_IDS.admin },
      });
      expect(await gate(req)).toEqual(ALLOW);
    });

    it('secures another baseID without Users module access', async () => {
      const req = extendedAttributes([Roles.systemUser], { baseID: USER_IDS.admin });
      expect(await gate(req)).toEqual(secure(req));
    });

    // A site-scoped token reaches no other site's grants, so a Users grant on a pooling site does not bypass.
    it('secures another baseID in a pool the token site does not grant', async () => {
      const req = makeAdminRequest(
        {
          circuit: 'cusers',
          item: 'loadExtendedAttributes',
          rc: { baseID: USER_IDS.admin, siteid: 'umbrella' },
          session: { siteid: 'umbrella' },
          user: { site: 'umbrella', roles: [Roles.systemUser] },
        },
        'siteAdmin',
      );
      expect(await gate(req)).toEqual(secure(req));
    });

    it('needs a baseID', async () => {
      const req = extendedAttributes([Roles.systemUser, moduleRole(USERS_MODULE)], {});
      expect(await gate(req)).toEqual(secure(req));
    });

    it('applies to no other action', async () => {
      const req = editorWith([Roles.systemUser], { rc: { baseID: editorRequest().session.mura.userID } });
      expect(await gate(req)).toEqual(secure(req));
    });
  });
});

describe('normaliseCusersRc', () => {
  it('falls back to the session siteid, then default', () => {
    expect(normaliseCusersRc(siteAdminRequest('tenant-a', { rc: { siteid: '' } })).siteid).toBe('tenant-a');
    const req = siteAdminRequest('tenant-a', { rc: { siteid: '' } });
    expect(normaliseCusersRc({ ...req, session: { ...req.session, siteid: '' } }).siteid).toBe('default');
    expect(normaliseCusersRc(siteAdminRequest('tenant-a', { rc: { siteid: 'tenant-b' } })).siteid).toBe('tenant-b');
  });

  it('reads names case-insensitively and keeps the request casing', () => {
    const rc = normaliseCusersRc(siteAdminRequest('tenant-a', { rc: { ISPUBLIC: '0', BaseID: 'B' } }));
    expect(rc.ispublic).toBe('0');
    expect(rc['baseid']).toBe('B');
    expect(Object.keys(rc)).toEqual(expect.arrayContaining(['ISPUBLIC', 'BaseID', 'Type', 'ContactForm']));
    expect('ISADMIN' in rc).toBe(true);
    expect(() => {
      (rc as unknown as Record<string, string>)['search'] = 'x';
    }).toThrow(TypeError);
  });

  it('sets isAdmin as isCusersAdmin does', () => {
    const cases: Array<[AdminRequest, boolean]> = [
      [adminS2Request(), true],
      [siteAdminRequest(), true],
      [editorRequest(), false],
    ];
    for (const [req, expected] of cases) {
      expect(normaliseCusersRc(req).isAdmin).toBe(expected);
      expect(isCusersAdmin(req)).toBe(expected);
    }
  });

  it('drops s2 for non-S2 users only', () => {
    const editor = normaliseCusersRc(editorRequest({ rc: { S2: '1' } }));
    expect(editor.s2).toBeUndefined();
    expect('s2' in editor).toBe(false);
    expect(normaliseCusersRc(adminS2Request({ rc: { s2: '1' } })).s2).toBe('1');
  });

  it('applies the param defaults', () => {
    const rc = normaliseCusersRc(editorRequest());
    expect(rc).toMatchObject({
      error: {},
      startRow: 1,
      recordsperpage: 25,
      userid: '',
      routeid: '',
      Type: '0',
      ContactForm: '0',
      isPublic: '1',
      email: '',
      lastupdatebyid: '0',
      fax: '',
      perm: '0',
      InActive: '0',
      returnurl: '',
      search: '',
      newsearch: false,
      unassigned: '0',
    });
    expect(rc.categoryid).toBe('');
    expect(rc.groupid).toBe('');
  });

  it.each([
    ['abc', 'admin', '1'],
    ['0', 'non-admin', '1'],
    ['0', 'admin', '0'],
    ['1', 'admin', '1'],
  ])('scrubs ispublic %s for an %s to %s', (value, who, expected) => {
    const req = who === 'admin' ? adminS2Request({ rc: { ispublic: value } }) : editorRequest({ rc: { ispublic: value } });
    expect(normaliseCusersRc(req).ispublic).toBe(expected);
  });

  it.each([
    ['x', '0', 1],
    ['0', '0', 1],
    ['no', 'no', 1],
    ['1', '1', 0],
  ])('scrubs unassigned %s to %s with unassignedlink %d', (value, unassigned, link) => {
    const rc = normaliseCusersRc(editorRequest({ rc: { unassigned: value } }));
    expect(rc.unassigned).toBe(unassigned);
    expect(rc.unassignedlink).toBe(link);
  });

  it.each([
    ['7', 7],
    ['12abc', 12],
    ['abc', 1],
    ['0', 1],
    ['-3', 1],
  ])('reads startRow %s with Val as %d', (value, expected) => {
    expect(normaliseCusersRc(editorRequest({ rc: { startrow: value } })).startRow).toBe(expected);
  });

  it.each([
    ['50', 50],
    ['0', 25],
    ['abc', 25],
  ])('reads recordsperpage %s with Val as %d', (value, expected) => {
    expect(normaliseCusersRc(editorRequest({ rc: { recordsperpage: value } })).recordsperpage).toBe(expected);
  });
});

describe('userPoolIdFor', () => {
  const pools = { publicUserPoolID: siteTenantA.publicUserPoolID, privateUserPoolID: siteTenantA.privateUserPoolID };

  it.each([
    ['an admin on system users', siteAdminRequest('tenant-a', { site: pools, rc: { ispublic: '0' } }), 'tenant-a'],
    ['an admin on site members', siteAdminRequest('tenant-a', { site: pools, rc: { ispublic: '1' } }), 'umbrella'],
    ['a non-admin on system users', editorRequest({ site: pools, rc: { ispublic: '0' } }), 'umbrella'],
  ])('gives %s its pool', (_who, req, expected) => {
    expect(userPoolIdFor(req, normaliseCusersRc(req))).toBe(expected);
  });

  it('throws without site data', () => {
    expect(() => userPoolIdFor({ site: undefined }, { ispublic: '0', isAdmin: true })).toThrow(TypeError);
  });
});
