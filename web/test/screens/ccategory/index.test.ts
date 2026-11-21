// The ccategory barrel against ccategory.cfc before(): its gate, its rc defaults and the screens it registers.
import { moduleRole, Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate } from '@/lib/access-gate';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import {
  CCATEGORY_RC_DEFAULTS,
  applyCcategoryDefaults,
  ccategoryGate,
  ccategoryScreens,
  ccategorySecondaryMenu,
} from '@/screens/ccategory';
import { ccategorySecondaryMenu as menuRenderer } from '@/screens/ccategory/secondary-menu';
import type { PageScreen } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  siteAdminRequest,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { BETA_ID, LIST_ROUTE, SAVE_ROUTE, categoryGateway, contextFor } from './support';

const CATEGORY_ROLE = moduleRole('00000000000000000000000000000000010');

/** A saved bean with every flag on and no other value. */
const SAVED_FLAGS = Object.freeze({
  categoryID: BETA_ID,
  isOpen: 1,
  isInterestGroup: 1,
  isfeatureable: 1,
  isActive: 1,
});
const SITE_MANAGER_ROLE = moduleRole('00000000000000000000000000000000000');

/** qa_editor on `default` holding `roles`. */
const editorWith = (roles: string[], rc: Record<string, string> = {}): AdminRequest =>
  makeAdminRequest({ circuit: 'cCategory', item: 'list', rc, user: { roles } }, 'qaEditor');

const screen = (action: string): PageScreen => {
  const found = ccategoryScreens.find((def) => def.action === action);
  if (found?.mode !== 'page') throw new Error(`No ccategory.${action} page screen`);
  return found;
};

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => {
  restoreEnv();
});

describe('ccategoryGate', () => {
  it.each([
    { label: 'S2', req: () => adminS2Request({ circuit: 'cCategory', item: 'list' }) },
    {
      label: "the token site's admin",
      req: () => siteAdminRequest('tenant-a', { circuit: 'cCategory', item: 'list' }),
    },
    {
      label: 'Categories plus Site Manager access',
      req: () => editorWith([Roles.systemUser, CATEGORY_ROLE, SITE_MANAGER_ROLE]),
    },
  ])('lets $label through', async ({ req }) => {
    expect(await runGate(req(), ccategoryGate)).toEqual({ kind: 'allow' });
  });

  it.each([
    { label: 'Site Manager access alone', req: () => editorRequest({ circuit: 'cCategory', item: 'list' }) },
    { label: 'Categories access alone', req: () => editorWith([Roles.systemUser, CATEGORY_ROLE]) },
    {
      label: 'module access for another site than the token serves',
      req: () => editorWith([Roles.systemUser, CATEGORY_ROLE, SITE_MANAGER_ROLE], { siteid: 'tenant-b' }),
    },
    {
      label: 'a site admin of another site',
      req: () => siteAdminRequest('tenant-a', { circuit: 'cCategory', item: 'list', rc: { siteid: 'default' } }),
    },
  ])('sends a logged-in user with $label back through secure()', async ({ req }) => {
    expect(await runGate(req(), ccategoryGate)).toEqual({ kind: 'redirect', location: './' });
  });

  it('sends an anonymous request to the login form', async () => {
    const decision = await runGate(anonymousRequest({ circuit: 'cCategory', item: 'list' }), ccategoryGate);
    expect(decision.kind === 'redirect' && decision.location).toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/);
  });
});

describe('applyCcategoryDefaults', () => {
  it('adds startrow and keywords where rc lacks them', () => {
    const rc = applyCcategoryDefaults(adminS2Request({ circuit: 'cCategory', item: 'list' }).rc);
    expect({ startrow: rc.startrow, keywords: rc.keywords }).toEqual(CCATEGORY_RC_DEFAULTS);
  });

  it('keeps values rc holds under any case, empty ones included', () => {
    const original = adminS2Request({ circuit: 'cCategory', item: 'list', rc: { StartRow: '3', KEYWORDS: '' } }).rc;
    const rc = applyCcategoryDefaults(original);
    expect(rc).toBe(original);
    expect({ startrow: rc.startrow, keywords: rc.keywords }).toEqual({ startrow: '3', keywords: '' });
  });
});

describe('ccategoryScreens', () => {
  it('registers frozen strategies-content screens behind ccategoryGate, with the circuit menu', () => {
    expect(
      ccategoryScreens.map(({ action, owner, gate, secondaryMenu }) => ({
        action,
        owner,
        gated: gate === ccategoryGate,
        secondaryMenu,
      })),
    ).toEqual(
      ['list', 'edit', 'update'].map((action) => ({
        action,
        owner: 'strategies-content',
        gated: true,
        secondaryMenu: 'ccategory',
      })),
    );
    expect(ccategoryScreens.every((def) => Object.isFrozen(def))).toBe(true);
    expect(ccategoryScreens.map((def) => 'redirect' in def)).toEqual([false, false, true]);
    expect(ccategorySecondaryMenu).toBe(menuRenderer);
  });

  it('loads the list on the request before() leaves', async () => {
    const ctx = contextFor(
      adminS2Request({ circuit: 'cCategory', item: 'list' }),
      categoryGateway({ [LIST_ROUTE]: { status: 200, body: { rc: { categories: [] } } } }),
    );
    const list = screen('list');
    const data = await list.load?.(ctx);

    expect(ctx.req.rc.startrow).toBe('1');
    expect(toString((await list.render(ctx, data)).body)).toContain('This site currently has no categories.');
  });

  it("runs update's save on the defaulted rc, then loads and renders the kept form for the same request", async () => {
    const ctx = contextFor(
      adminS2Request({
        circuit: 'cCategory',
        item: 'update',
        rc: { categoryID: BETA_ID, parentID: '', action: 'update' },
      }),
      categoryGateway({
        [SAVE_ROUTE]: {
          status: 200,
          body: {
            saved: false,
            errors: { name: 'Required' },
            redirect: null,
            data: { rc: { categoryBean: SAVED_FLAGS, rsRestrictGroups: [], categories: [] } },
          },
        },
      }),
    );
    const update = screen('update');

    expect(await update.redirect?.(ctx)).toBeUndefined();
    expect(ctx.gateway.calls[0]?.form).toMatchObject({ startrow: '1', keywords: '', action: 'update' });
    const body = toString((await update.render(ctx, await update.load?.(ctx))).body);
    expect(body).toContain('<h1>Edit Content Category</h1>');
    expect(body).toContain('<span>Required </span>');
  });
});
