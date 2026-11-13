// The cperm entries against the inventory, the before() gate in the page pipeline and the partials over a session.
// partials-markup.test.ts pins the partials byte for byte, so their markup is asserted here only as screens reach it.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { runGate, secure, type GateDecision } from '@/lib/access-gate';
import { legacySettings } from '@/lib/env';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { cpermScreens } from '@/screens/cperm';
import {
  CONTENT_MODULE_ID,
  TOP_NODE_ID,
  cpermDefaults,
  cpermGate,
  renderBackNav,
  renderNoGroups,
  renderZoom,
  type ZoomCrumb,
} from '@/screens/cperm/partials';
import { adminS2Request, anonymousRequest, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, type DomLink } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { makeScreenContext } from '../../helpers/screen-context';

// The real registry imports every circuit; the screen context needs only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const MAIN = { circuit: 'cperm', item: 'main' } as const;
const ALLOW: GateDecision = { kind: 'allow' };
const NODE_ID = 'A1000000-0000-0000-0000000000000001';
const PARENT_ID = 'A1000000-0000-0000-0000000000000002';
const INVENTORY_URL = new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url);
const CPERM_KEY_PREFIX = 'admin:cperm.';

/** An admin action or variant record as the inventory stores it. */
interface InventoryVariant {
  readonly routeKey: string;
  readonly disposition: string | null;
  readonly owningService: string | null;
  readonly responseMode: string | null;
}

interface InventoryController {
  readonly actions?: ReadonlyArray<{ readonly variants?: readonly InventoryVariant[] }>;
}

/** A cperm action with the owner and response mode that serve it. */
interface Served {
  readonly action: string;
  readonly owner: string | null;
  readonly mode: string | null;
}

/** Every inventoried cperm admin record, keyed by its normalised action. */
function cpermInventory(): Array<InventoryVariant & { readonly action: string }> {
  const { controllers } = JSON.parse(readFileSync(INVENTORY_URL, 'utf8')) as {
    controllers: readonly InventoryController[];
  };
  return controllers
    .flatMap((controller) => (controller.actions ?? []).flatMap((action) => action.variants ?? []))
    .map((variant) => ({ ...variant, routeKey: normaliseRouteKey(variant.routeKey) }))
    .filter((variant) => variant.routeKey.startsWith(CPERM_KEY_PREFIX))
    .map((variant) => ({ ...variant, action: variant.routeKey.slice(CPERM_KEY_PREFIX.length) }));
}

const byServedAction = (rows: readonly Served[]): Served[] => rows.toSorted((a, b) => a.action.localeCompare(b.action));

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The admin bundle a cperm screen gets for `req`'s session. */
const sessionRb = (req: AdminRequest) => makeScreenContext({ req }).rb;

/** dspZoom's `cArch.list` link to a tenant-a crumb, as the DOM model reports it. */
function zoomLink(contentid: string, text: string): DomLink {
  const { context, adminDir } = legacySettings();
  const query = `siteid=tenant-a&topid=${contentid}&moduleid=${CONTENT_MODULE_ID}&activeTab=0`;
  return { href: normaliseAdminUrl(`${context}${adminDir}/?muraAction=cArch.list&${query}`), text };
}

describe('cpermScreens', () => {
  const byAction = new Map(cpermScreens.map((def) => [def.action, def]));
  const inventory = cpermInventory();
  const withheld = new Set(inventory.filter((record) => record.disposition !== 'carry').map((record) => record.action));

  it.each([
    ['main', 'page'],
    ['module', 'page'],
    ['updatemodule', 'redirect'],
  ])('serves cperm.%s in %s mode', (action, mode) => {
    expect(byAction.get(action)).toMatchObject({ circuit: 'cperm', action, mode });
  });

  it('serves exactly the carried inventory actions with their owner and mode', () => {
    const carried = inventory
      .filter((record) => record.disposition === 'carry')
      .map((record): Served => ({ action: record.action, owner: record.owningService, mode: record.responseMode }));
    expect(carried).not.toHaveLength(0);
    const served = cpermScreens.map((def): Served => ({ action: def.action, owner: def.owner, mode: def.mode }));
    expect(byServedAction(served)).toEqual(byServedAction(carried));
  });

  it('registers no withheld action, update included', () => {
    expect([...withheld]).toContain('update');
    expect(cpermScreens.filter((def) => withheld.has(def.action))).toEqual([]);
    expect(byAction.has('update')).toBe(false);
  });

  it.each(cpermScreens.map((def) => [def.action, def] as const))('owns cperm.%s in identity behind the gate', (_action, def) => {
    expect(def.owner).toBe('identity');
    expect(def.gate).toBe(cpermGate);
  });

  it('registers each lower-case action once, frozen', () => {
    const keys = cpermScreens.map((def) => `${def.circuit}.${def.action}{${def.variant?.key ?? ''}}`);
    expect(keys).toEqual(keys.map((key) => key.toLowerCase()));
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.isFrozen(cpermScreens)).toBe(true);
  });
});

describe('cpermGate in the page pipeline', () => {
  it.each<[string, () => AdminRequest, boolean]>([
    ['the S2 admin', () => adminS2Request(MAIN), true],
    ['the tenant-a site admin', () => siteAdminRequest('tenant-a', MAIN), true],
    ['the editor', () => editorRequest(MAIN), false],
    [
      'an editor whose rc claims S2 and Admin',
      () => editorRequest({ ...MAIN, rc: { s2: '1', isAdmin: 'true', memberships: 'S2', siteid: 'tenant-a' } }),
      false,
    ],
    ['an anonymous user', () => anonymousRequest(MAIN), false],
  ])('answers %s', async (_who, makeReq, allowed) => {
    const req = makeReq();
    expect(await runGate(req, cpermGate)).toEqual(allowed ? ALLOW : secure(req));
  });

  it('sends the editor back and the anonymous user to the login form', async () => {
    expect(await runGate(editorRequest(MAIN), cpermGate)).toEqual({ kind: 'redirect', location: './' });
    const login = await runGate(anonymousRequest(MAIN), cpermGate);
    expect(login.kind).toBe('redirect');
    const location = login.kind === 'redirect' ? login.location : '';
    expect(location).toContain('muraAction=cLogin.main');
    expect(new URLSearchParams(location.slice(location.indexOf('?') + 1)).has('returnURL')).toBe(true);
  });
});

describe('cperm partials over the session', () => {
  it('defaults the tenant-a rc around the values it carries', () => {
    const { req } = makeScreenContext({ req: siteAdminRequest('tenant-a', { ...MAIN, rc: { topid: 'X', startrow: '5' } }) });
    const rc = cpermDefaults(req.rc);
    expect([rc['siteid'], rc['topid'], rc['startrow'], rc['Contentid'], rc['chainID']]).toEqual([
      'tenant-a',
      'X',
      '5',
      '',
      '',
    ]);
    const empty = cpermDefaults(siteAdminRequest('tenant-a', MAIN).rc);
    expect(empty['topid']).toBe('');
    expect(empty['topid']).not.toBe(TOP_NODE_ID);
  });

  it('renders the en Back nav as one history link', () => {
    const markup = toString(renderBackNav(sessionRb(siteAdminRequest('tenant-a', MAIN))));
    expect(markup).toContain('<div class="nav-module-specific btn-group">');
    expect(markup).toContain('title="Back"');
    expect(markup).toContain('onclick="window.history.back(); return false;"');
    expect(markup).toContain('<i class="mi-arrow-circle-left"></i> Back</a>');
    expect(fragmentModel(markup).links).toEqual([{ href: '#', text: 'Back' }]);
  });

  it('encodes the de Back label again and writes the de notice as the bundle holds it', () => {
    const rb = sessionRb(siteAdminRequest('tenant-a', { ...MAIN, session: { rb: 'de' } }));
    const back = toString(renderBackNav(rb));
    expect(back).toContain('title="Zur&amp;uuml&#x3b;ck"');
    expect(fragmentModel(back).links).toEqual([{ href: '#', text: 'Zur&uuml;ck' }]);
    expect(toString(renderNoGroups(rb, { leadingSpace: true }))).toBe(
      '<div class="help-block-empty"> Derzeit sind keine Administrator-Gruppen vorhanden.</div>',
    );
  });

  it('models the en empty-group notice as plain text, not an alert', () => {
    const rb = sessionRb(siteAdminRequest('tenant-a', MAIN));
    const markup = toString(renderNoGroups(rb, { leadingSpace: false }));
    expect(markup).toBe('<div class="help-block-empty">There are currently no groups available.</div>');
    expect(fragmentModel(markup).alerts).toEqual([]);
  });

  it('models the tenant-a crumbs root first, locking below the restricted folder', () => {
    const crumbs: ZoomCrumb[] = [
      { menutitle: 'A & <B>', siteid: 'tenant-a', contentid: NODE_ID, type: 'Page', restricted: 0, icon: 'mi-file' },
      {
        menutitle: 'Programs',
        siteid: 'tenant-a',
        contentid: PARENT_ID,
        moduleid: CONTENT_MODULE_ID,
        type: 'Folder',
        restricted: 1,
        icon: 'mi-folder',
      },
      { menutitle: 'Home', siteid: 'tenant-a', contentid: TOP_NODE_ID, type: 'Page', restricted: 0, icon: 'mi-home' },
    ];
    const markup = toString(renderZoom(crumbs, { className: 'breadcrumb' }));
    expect(markup.startsWith('<ul class="breadcrumb">')).toBe(true);
    expect(fragmentModel(markup).links).toEqual([
      zoomLink(TOP_NODE_ID, 'Home'),
      zoomLink(PARENT_ID, 'Programs'),
      zoomLink(NODE_ID, 'A & <B>'),
    ]);
    expect(Array.from(markup.matchAll(/<li class="([^"]*)"/g), (m) => m[1])).toEqual(['', 'locked', 'locked']);
    expect(markup.match(/<strong>[\s\S]*?<\/strong>/g)).toEqual([expect.stringContaining(`topid=${NODE_ID}&`)]);
    expect(markup).toContain('A &amp; &lt;B&gt;</a>');
  });
});
