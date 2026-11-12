// cfeed before(): the access gate and rc param defaults of admin/core/controllers/cfeed.cfc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { CFEED_RC_DEFAULTS, applyCfeedDefaults, cfeedGate } from '@/screens/cfeed/before';
import {
  adminS2Request,
  anonymousRequest,
  makeAdminRequest,
  siteAdminRequest,
  unservedEditorRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

const COLLECTIONS = moduleRole('00000000000000000000000000000000011');
const CONTENT = moduleRole('00000000000000000000000000000000000');
const LIST = { circuit: 'cfeed', item: 'list' } as const;
const FEEDS = { ...LIST, site: { hasFeedManager: true } } as const;

// cfeed.cfc's `param` defaults, in source order.
const LEGACY_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['startrow', '1'],
  ['keywords', ''],
  ['categoryID', ''],
  ['contentID', ''],
  ['restricted', '0'],
  ['closeCompactDisplay', ''],
  ['compactDisplay', ''],
  ['homeID', ''],
  ['action', ''],
  ['assignmentID', ''],
  ['regionID', '0'],
  ['orderno', '0'],
  ['instanceParams', ''],
  ['instanceid', ''],
];

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** qa_editor holding exactly `roles`, on a site whose feed manager is on unless `partial` says otherwise. */
const editorWith = (roles: readonly string[], partial: AdminRequestPartial = FEEDS): AdminRequest =>
  makeAdminRequest({ ...partial, user: { roles: [...roles] } }, 'qaEditor');

/** The gate's decision for `req`, with how often it called `secure()`. */
async function gate(req: AdminRequest): Promise<{ decision: GateDecision; secureCalls: number }> {
  const spy = vi.fn(() => secure(req));
  const decision = await cfeedGate(req, { secure: spy });
  return { decision, secureCalls: spy.mock.calls.length };
}

describe('cfeedGate', () => {
  it.each<[string, () => AdminRequest]>([
    ['S2', () => adminS2Request(FEEDS)],
    ['a site admin', () => siteAdminRequest('tenant-a', FEEDS)],
    ['collections and content module access', () => editorWith([Roles.systemUser, COLLECTIONS, CONTENT])],
  ])('allows %s on a site with the feed manager', async (_label, request) => {
    expect(await gate(request())).toEqual({ decision: { kind: 'allow' }, secureCalls: 0 });
  });

  it.each<[string, () => AdminRequest]>([
    ['S2 on a site without the feed manager', () => adminS2Request(LIST)],
    ['a site admin without the feed manager', () => siteAdminRequest('tenant-a', LIST)],
    ['module access without the feed manager', () => editorWith([Roles.systemUser, COLLECTIONS, CONTENT], LIST)],
    [
      'module access on a session site with no site data',
      () => unservedEditorRequest({ ...LIST, user: { roles: [Roles.systemUser, COLLECTIONS, CONTENT] } }),
    ],
    ['collections access alone', () => editorWith([Roles.systemUser, COLLECTIONS])],
    ['content access alone', () => editorWith([Roles.systemUser, CONTENT])],
    [
      'privileges claimed in rc',
      () => editorWith([Roles.systemUser, CONTENT], { ...FEEDS, rc: { s2: '1', memberships: 'S2' } }),
    ],
    ['anonymous', () => anonymousRequest(FEEDS)],
  ])('secures %s', async (_label, request) => {
    const req = request();

    expect(await gate(req)).toEqual({ decision: secure(req), secureCalls: 1 });
  });
});

describe('CFEED_RC_DEFAULTS', () => {
  it("holds legacy's params in order, frozen", () => {
    expect(Object.entries(CFEED_RC_DEFAULTS)).toEqual(LEGACY_DEFAULTS);
    expect(Object.isFrozen(CFEED_RC_DEFAULTS)).toBe(true);
  });
});

describe('applyCfeedDefaults', () => {
  it('adds every param to an empty rc, in order', () => {
    expect(Object.entries(applyCfeedDefaults({}))).toEqual(LEGACY_DEFAULTS);
  });

  it('keeps values rc already holds under any case', () => {
    const rc = adminS2Request({ ...LIST, rc: { STARTROW: '21', Keywords: 'news', regionid: '3' } }).rc;

    const result = applyCfeedDefaults(rc);

    expect(Object.fromEntries(LEGACY_DEFAULTS.map(([name]) => [name, result[name]]))).toEqual({
      startrow: '21',
      keywords: 'news',
      categoryID: '',
      contentID: '',
      restricted: '0',
      // The admin set-up's `false` precedes the controller's `param`.
      closeCompactDisplay: 'false',
      compactDisplay: 'false',
      homeID: '',
      action: '',
      assignmentID: '',
      regionID: '3',
      orderno: '0',
      instanceParams: '',
      instanceid: '',
    });
    expect(Object.keys(result).filter((name) => /^(startrow|keywords|regionid)$/i.test(name))).toEqual([
      'STARTROW',
      'Keywords',
      'regionid',
    ]);
  });

  it('returns a read-only copy and leaves rc unchanged', () => {
    const rc = { Keywords: 'news' };

    const result = applyCfeedDefaults(rc);

    expect(rc).toEqual({ Keywords: 'news' });
    expect(Reflect.set(result, 'startrow', '5')).toBe(false);
    expect([result.STARTROW, result.keywords]).toEqual(['1', 'news']);
  });
});
