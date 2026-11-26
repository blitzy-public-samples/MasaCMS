// ccategory before(): the gate of admin/core/controllers/ccategory.cfc against the real controller secure().
import { Roles, moduleRole } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { ccategoryGate, ccategoryScreens } from '@/screens/ccategory';
import type { PageScreen } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';
import { BETA_ID, categoryGateway, categoryRoute, contextFor } from './support';

const CATEGORIES = moduleRole('00000000000000000000000000000000010');
const SITE_MANAGER = moduleRole('00000000000000000000000000000000000');
const LIST = { circuit: 'cCategory', item: 'list' } as const;
const ALLOW: GateDecision = { kind: 'allow' };
const REFERER = 'http://localhost/admin/?muraAction=cArch.list&siteid=default';

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** qa_editor on `default` holding exactly `roles`. */
const editorWith = (roles: readonly string[], partial: AdminRequestPartial = LIST): AdminRequest =>
  makeAdminRequest({ ...partial, user: { roles: [...roles] } }, 'qaEditor');

/** The gate's decision for `req`, with how often it called `secure()`. */
async function gate(req: AdminRequest): Promise<{ decision: GateDecision; secureCalls: number }> {
  const spy = vi.fn(() => secure(req));
  const decision = await ccategoryGate(req, { secure: spy });
  return { decision, secureCalls: spy.mock.calls.length };
}

/** `secure(req)`, asserted to redirect so a denial never matches an allow. */
function secured(req: AdminRequest): GateDecision {
  const decision = secure(req);
  expect(decision.kind).toBe('redirect');
  return decision;
}

/** The registered ccategory page screen of `action`. */
function page(action: string): PageScreen {
  const found = ccategoryScreens.find((def) => def.action === action);
  if (found?.mode !== 'page') throw new Error(`No ccategory.${action} page screen`);
  return found;
}

describe('ccategoryGate', () => {
  it.each<[string, () => AdminRequest]>([
    ['S2', () => adminS2Request(LIST)],
    ['the tenant-a site admin', () => siteAdminRequest('tenant-a', LIST)],
    ['Categories plus Site Manager', () => editorWith([Roles.systemUser, CATEGORIES, SITE_MANAGER])],
    [
      'Categories plus Site Manager on the token site in another case',
      () => editorWith([Roles.systemUser, CATEGORIES, SITE_MANAGER], { ...LIST, rc: { siteid: 'DEFAULT' } }),
    ],
  ])('allows %s without calling secure()', async (_who, request) => {
    expect(await gate(request())).toEqual({ decision: ALLOW, secureCalls: 0 });
  });

  it.each<[string, () => AdminRequest]>([
    ['Site Manager alone (qa_editor)', () => editorRequest(LIST)],
    ['Categories alone', () => editorWith([Roles.systemUser, CATEGORIES])],
    ['a system user without module access', () => editorWith([Roles.systemUser])],
    ['an anonymous user', () => anonymousRequest(LIST)],
  ])('secures %s', async (_who, request) => {
    const req = request();
    expect(await gate(req)).toEqual({ decision: secured(req), secureCalls: 1 });
  });

  it('sends a denied logged-in user back to the referrer', async () => {
    const req = editorRequest({ ...LIST, headers: new Headers({ referer: REFERER }) });
    expect(await gate(req)).toEqual({ decision: { kind: 'redirect', location: REFERER }, secureCalls: 1 });
  });

  it('sends an anonymous user to the login form with the return URL and compactDisplay', async () => {
    const { decision } = await gate(anonymousRequest({ ...LIST, rc: { compactDisplay: 'true' } }));
    expect(decision.kind).toBe('redirect');
    const location = decision.kind === 'redirect' ? decision.location : '';
    expect(location).toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/);
    expect(location).toContain(encodeURIComponent('muraAction=cCategory.list'));
    expect(location).toMatch(/&compactDisplay=true$/);
  });

  it.each(REQUESTED_SITE_CASES)('admits $who only when it administers that site', async ({ request, administers }) => {
    const req = request(LIST);
    expect(await gate(req)).toEqual(
      administers ? { decision: ALLOW, secureCalls: 0 } : { decision: secured(req), secureCalls: 1 },
    );
  });
});

// The port applies before()'s `param` defaults in each screen step, so the gate itself never writes rc.
describe('ccategory rc defaults', () => {
  it('leaves rc to the screen steps', async () => {
    const req = adminS2Request(LIST);
    const rc = { ...req.rc };
    await gate(req);
    expect(req.rc).toEqual(rc);
    expect(req.rc.startrow).toBeUndefined();
  });

  it.each<[string, Record<string, string>, Record<string, string>]>([
    ['adds startrow and keywords', {}, { startrow: '1', keywords: '' }],
    ['keeps startrow and keywords', { startrow: '21', keywords: 'news' }, { startrow: '21', keywords: 'news' }],
  ])('%s before the edit step reads rc', async (_label, rc, expected) => {
    const req = adminS2Request({ circuit: 'cCategory', item: 'edit', rc: { categoryID: BETA_ID, ...rc } });
    expect((await gate(req)).decision).toEqual(ALLOW);
    const ctx = contextFor(
      req,
      categoryGateway({
        [categoryRoute(BETA_ID)]: {
          status: 200,
          body: { rc: { categoryBean: { categoryID: BETA_ID }, rsRestrictGroups: [], categories: [] } },
        },
      }),
    );

    await page('edit').load?.(ctx);

    expect({ startrow: ctx.req.rc.startrow, keywords: ctx.req.rc.keywords }).toEqual(expected);
  });
});

// `update` is a page whose save runs as its redirect step, so every entry is in `page` mode.
describe('ccategoryScreens', () => {
  it('registers list, edit and update as strategies-content pages behind ccategoryGate', () => {
    expect(
      ccategoryScreens.map(({ circuit, action, mode, owner, gate: screenGate, secondaryMenu }) => ({
        circuit,
        action,
        mode,
        owner,
        gate: screenGate,
        secondaryMenu,
      })),
    ).toEqual(
      ['list', 'edit', 'update'].map((action) => ({
        circuit: 'ccategory',
        action,
        mode: 'page',
        owner: 'strategies-content',
        gate: ccategoryGate,
        secondaryMenu: 'ccategory',
      })),
    );
  });
});
