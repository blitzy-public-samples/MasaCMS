// The screen registry against the inventory's admin dispositions: carried actions served once, nothing else served.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import type { ScreenGate } from '@/lib/access-gate';
import { carchContentNav } from '@/screens/carch/content-nav';
import { carchGate } from '@/screens/carch/controller';
import { carchSecondaryMenu } from '@/screens/carch/secondary-menu';
import { ccategorySecondaryMenu } from '@/screens/ccategory/secondary-menu';
import { cchainGate } from '@/screens/cchain';
import { cchangesetsSecondaryMenu } from '@/screens/cchangesets/secondary-menu';
import { cfeedSecondaryMenu } from '@/screens/cfeed/secondary-menu';
import { cloginScreens } from '@/screens/clogin';
import { homeRedirectScreen } from '@/screens/clogin/home-redirect';
import {
  NOT_BUILT_VARIANTS,
  allScreens,
  findScreen,
  routeKeyOf,
  shellHooks,
  type NotBuiltVariant,
  type Rc,
  type ScreenDefinition,
  type UploadPart,
} from '@/screens/registry';

/** An inventoried admin action or variant. */
interface AdminRecord {
  readonly routeKey: string;
  readonly disposition: string | null;
  readonly owningService: string | null;
  readonly responseMode: string | null;
  readonly exceptionRef: string | null;
}

interface InventoryFile {
  readonly controllers: ReadonlyArray<{
    readonly actions?: ReadonlyArray<{ readonly variants?: readonly AdminRecord[] }>;
  }>;
}

const INVENTORY = JSON.parse(
  readFileSync(new URL('../../../opt2/inventory/legacy-inventory.json', import.meta.url), 'utf8'),
) as InventoryFile;

/** Every admin action and variant record of `inventory`, keys normalised. */
function adminRecords(inventory: InventoryFile): AdminRecord[] {
  return inventory.controllers
    .flatMap((controller) => controller.actions ?? [])
    .flatMap((action) => action.variants ?? [])
    .map(({ routeKey, disposition, owningService, responseMode, exceptionRef }) => ({
      routeKey: normaliseRouteKey(routeKey),
      disposition,
      owningService,
      responseMode,
      exceptionRef: exceptionRef ?? null,
    }))
    .filter((record) => record.routeKey.startsWith('admin:'));
}

const MIGRATED_OWNERS: readonly string[] = ['identity', 'people', 'programs-sites', 'strategies-content'];

const RECORDS: ReadonlyMap<string, AdminRecord> = new Map(
  adminRecords(INVENTORY).map((record) => [record.routeKey, record] as const),
);

const isCarried = (record: AdminRecord): boolean =>
  record.disposition === 'carry' && MIGRATED_OWNERS.includes(record.owningService ?? '');

const CARRIED: readonly string[] = [...RECORDS.values()].filter(isCarried).map((record) => record.routeKey);

// A carried record naming an exceptions-list entry is a halted case: a legacy-write entry web never serves.
const HALTED: ReadonlySet<string> = new Set(
  [...RECORDS.values()].filter((r) => isCarried(r) && r.exceptionRef !== null).map((r) => r.routeKey),
);

/** A carried key no definition of its own registers, with the request that reaches it. */
interface UnregisteredCarry {
  readonly key: string;
  readonly circuit: string;
  readonly action: string;
  readonly rc: Rc;
}

// No programs-sites screen serves updateSite's residual branch (its Update branch writes the decision-list table
// tentity) or the withheld site copy's result page, so both stay on legacy.
const KEPT_ON_LEGACY: readonly UnregisteredCarry[] = [
  { key: normaliseRouteKey('admin:csettings.updatesite'), circuit: 'csettings', action: 'updatesite', rc: {} },
  { key: normaliseRouteKey('admin:csettings.sitecopyresult'), circuit: 'csettings', action: 'sitecopyresult', rc: {} },
];

/** A carried view-only action another view also includes, with the circuit gate that serves it. */
interface IncludedView {
  readonly key: string;
  readonly circuit: string;
  readonly action: string;
  readonly owner: string;
  readonly gate: ScreenGate;
}

// update.cfm includes cchain/edit.cfm and list.cfm includes carch/scaffold.cfm as its Custom Entities tab; each included
// view is an action of its own.
const INCLUDED_VIEWS: readonly IncludedView[] = [
  {
    key: normaliseRouteKey('admin:cchain.edit'),
    circuit: 'cchain',
    action: 'edit',
    owner: 'strategies-content',
    gate: cchainGate,
  },
  {
    key: normaliseRouteKey('admin:carch.scaffold'),
    circuit: 'carch',
    action: 'scaffold',
    owner: 'strategies-content',
    gate: carchGate,
  },
];

const DEFS: readonly ScreenDefinition[] = allScreens();
const REGISTERED: readonly string[] = DEFS.map((def) => normaliseRouteKey(routeKeyOf(def)));

/** The definition registered under `key`. */
const defOf = (key: string): ScreenDefinition | undefined => DEFS[REGISTERED.indexOf(normaliseRouteKey(key))];

/** Registered keys among `keys`. */
const registeredOf = (keys: Iterable<string>): string[] =>
  [...keys].map(normaliseRouteKey).filter((key) => REGISTERED.includes(key));

describe('inventory carry set', () => {
  it('holds the carried admin actions of the migrated domains', () => {
    expect(CARRIED.length).toBeGreaterThan(0);
    expect(CARRIED).toEqual(
      expect.arrayContaining(
        [
          'admin:clogin.main',
          'admin:home.redirect',
          'admin:cusers.update{type=1}',
          'admin:cusers.update{type=2,action=add}',
          'admin:cusers.update{type=2,action=update}',
          'admin:csettings.editsite',
        ].map(normaliseRouteKey),
      ),
    );
  });
});

describe('registered admin screens', () => {
  it('registers no route key twice', () => {
    expect(REGISTERED.filter((key, index) => REGISTERED.indexOf(key) !== index)).toEqual([]);
  });

  it('registers every carried action once', () => {
    const unregistered = new Set([...HALTED, ...KEPT_ON_LEGACY.map((entry) => entry.key)]);
    const missing = CARRIED.filter(
      (key) => !unregistered.has(key) && REGISTERED.filter((registered) => registered === key).length !== 1,
    );
    expect(missing).toEqual([]);
  });

  it('registers only carried inventory keys', () => {
    const stray = REGISTERED.filter((key) => {
      const record = RECORDS.get(key);
      return record === undefined || !isCarried(record);
    });
    expect(stray).toEqual([]);
  });

  it('serves each key in its inventoried mode and owner', () => {
    const mismatches = DEFS.flatMap((def) => {
      const key = normaliseRouteKey(routeKeyOf(def));
      const entry = RECORDS.get(key);
      if (entry === undefined || (def.mode === entry.responseMode && def.owner === entry.owningService)) return [];
      return [
        { key, mode: def.mode, responseMode: entry.responseMode, owner: def.owner, owningService: entry.owningService },
      ];
    });
    expect(mismatches).toEqual([]);
  });

  it('leaves the halted carried keys to legacy', () => {
    expect([...HALTED]).toEqual(
      expect.arrayContaining(
        [
          'admin:carch.cropimage',
          'admin:carch.datamanager',
          'admin:carch.edit',
          'admin:carch.imagedetails',
          'admin:carch.multifileupload',
          'admin:carch.search',
          'admin:cchain.save',
          'admin:ceditprofile.update',
          'admin:cusers.update{type=2,action=update}',
          'admin:cwebservice.edit',
          'admin:cwebservice.save',
        ].map(normaliseRouteKey),
      ),
    );
    expect(registeredOf(HALTED)).toEqual([]);
  });

  it.each(KEPT_ON_LEGACY)('keeps $key on legacy', ({ key, circuit, action, rc }) => {
    expect(CARRIED).toContain(key);
    expect(registeredOf([key])).toEqual([]);
    expect(findScreen(circuit, action, rc)).toBeUndefined();
  });

  it.each(INCLUDED_VIEWS)('registers the carried $key page once behind its circuit gate', (view) => {
    expect(CARRIED).toContain(view.key);
    expect(RECORDS.get(view.key)).toMatchObject({
      responseMode: 'page',
      owningService: view.owner,
      exceptionRef: null,
    });
    expect(REGISTERED.filter((registered) => registered === view.key)).toEqual([view.key]);
    const def = defOf(view.key);
    expect(def).toMatchObject({ circuit: view.circuit, action: view.action, mode: 'page', owner: view.owner });
    expect(def?.gate).toBe(view.gate);
    expect(findScreen(view.circuit, view.action.toUpperCase(), {})).toBe(def);
  });

  it('registers home.redirect as a clogin screen of identity', () => {
    expect(cloginScreens).toContain(homeRedirectScreen);
    expect(normaliseRouteKey(routeKeyOf(homeRedirectScreen))).toBe(normaliseRouteKey('admin:home.redirect'));
    expect(homeRedirectScreen.owner).toBe('identity');
    expect(defOf('admin:home.redirect')).toBe(homeRedirectScreen);
  });
});

const NOT_REPRODUCED_CIRCUITS: readonly string[] = [
  'cextend',
  'ctrash',
  'cemail',
  'cmailinglist',
  'cdashboard',
  'cfilemanager',
  'cplugins',
  'scaffold',
  'razuna',
];

const WITHHELD_OR_LEGACY_SERVED_KEYS: readonly string[] = [
  'admin:csettings.updatesite{action=add}',
  'admin:csettings.updatesite{action=delete}',
  'admin:csettings.sitecopy',
  'admin:csettings.sitecopyselect',
  'admin:csettings.sitecopyresult',
  'admin:csettings.createbundle',
  'admin:csettings.selectbundleoptions',
  'admin:csettings.exporthtml',
  'admin:csettings.editplugin',
  'admin:csettings.deployplugin',
  'admin:csettings.updateplugin',
  'admin:csettings.updatepluginversion',
  'admin:csettings.deleteplugin',
  'admin:cusers.update{type=2,action=delete}',
  'admin:carch.export',
  'admin:carch.exportcontent',
  'admin:carch.importcontent',
  'admin:carch.exportcomponent',
  'admin:carch.importcomponent',
  'admin:carch.import',
  'admin:carch.emailtest',
  'admin:carch.cropimage',
  'admin:carch.flipimage',
  'admin:carch.rotateimage',
  'admin:carch.update',
  'admin:carch.updateobjectparams',
  'admin:carch.savequickedit',
  'admin:carch.variationtargeting',
  'admin:carch.copy',
  'admin:cchangesets.publish',
  'admin:cchangesets.rollback',
];

describe('withheld and legacy-served actions', () => {
  it('registers no action of a circuit web does not reproduce', () => {
    expect(REGISTERED.filter((key) => NOT_REPRODUCED_CIRCUITS.some((c) => key.startsWith(`admin:${c}.`)))).toEqual([]);
  });

  it('registers none of the withheld or legacy-served keys', () => {
    expect(registeredOf(WITHHELD_OR_LEGACY_SERVED_KEYS)).toEqual([]);
  });

  it('registers no photo or image-upload variant', () => {
    expect(REGISTERED.filter((key) => /\{[^}]*(photo|upload=image)/.test(key))).toEqual([]);
  });

  it('registers no inventory record that is not carried', () => {
    expect(registeredOf([...RECORDS.values()].filter((r) => !isCarried(r)).map((r) => r.routeKey))).toEqual([]);
  });
});

/** A findScreen request. */
interface LookupCase {
  readonly label: string;
  readonly circuit: string;
  readonly action: string;
  readonly rc: Rc;
  readonly uploads?: readonly UploadPart[];
}

const HOME_ID = '00000000000000000000000000000000001';

/** A Site Manager sort's cArch.list lookup, its POST folded into the rc with repeated `orderid` comma-joined. */
const siteManagerSort = (label: string, fields: Rc): LookupCase => ({
  label,
  circuit: 'cArch',
  action: 'list',
  rc: {
    siteid: 'tenant-a',
    moduleid: '00000000000000000000000000000000000',
    sortBy: 'orderno',
    sortDirection: 'asc',
    saveSort: 'true',
    startrow: '1',
    sorted: 'true',
    ...fields,
  },
  uploads: [],
});

const REFUSED: readonly LookupCase[] = [
  {
    label: 'a forgot-password request on the login page',
    circuit: 'clogin',
    action: 'main',
    rc: { status: 'sendLogin', email: 'admin@example.com' },
  },
  {
    label: 'a forgot-password post to the login action',
    circuit: 'cLogin',
    action: 'login',
    rc: { status: 'SENDLOGIN' },
  },
  { label: 'a roster delete', circuit: 'cusers', action: 'update', rc: { type: '2', action: 'Delete' } },
  { label: 'a roster edit', circuit: 'cUsers', action: 'update', rc: { TYPE: '2', action: 'update' } },
  {
    label: 'a roster edit with a photo',
    circuit: 'cusers',
    action: 'update',
    rc: { type: '2', action: 'Update', newFile: 'photo.jpg' },
  },
  {
    label: 'a group save removing its photo',
    circuit: 'cusers',
    action: 'update',
    rc: { type: '1', removePhotoFile: 'true' },
  },
  { label: 'a profile save with a photo', circuit: 'ceditprofile', action: 'update', rc: { newFile: 'me.png' } },
  { label: 'a profile save', circuit: 'ceditprofile', action: 'update', rc: {} },
  { label: 'site add', circuit: 'csettings', action: 'updatesite', rc: { action: 'Add' } },
  { label: 'site delete', circuit: 'csettings', action: 'updatesite', rc: { action: 'Delete' } },
  { label: 'site update', circuit: 'csettings', action: 'updatesite', rc: { action: 'Update' } },
  { label: 'site copy', circuit: 'csettings', action: 'sitecopy', rc: {} },
  { label: 'an image upload read from rc', circuit: 'carch', action: 'update', rc: { newfile: 'photo.jpg' } },
  {
    label: 'an image upload part',
    circuit: 'carch',
    action: 'update',
    rc: {},
    uploads: [{ field: 'newfile', filename: 'Photo.JPEG' }],
  },
  {
    label: 'a content save with a non-image upload',
    circuit: 'carch',
    action: 'update',
    rc: { newfile: 'doc.pdf' },
    uploads: [{ field: 'newfile', filename: 'doc.pdf' }],
  },
  { label: 'an approval', circuit: 'carch', action: 'approvalaction', rc: { action: 'Approve' } },
  {
    label: 'a compact-display collection save',
    circuit: 'cFeed',
    action: 'update',
    rc: { feedID: 'F-1', action: 'update', closeCompactDisplay: 'TRUE' },
  },
  {
    label: 'a form import with a zip part',
    circuit: 'cForm',
    action: 'importForm',
    rc: { title: 'Imported' },
    uploads: [{ field: 'formzip', filename: 'form.zip' }],
  },
  { label: 'a form import whose formzip rc holds a file name', circuit: 'cform', action: 'importform', rc: { formzip: 'form.zip' } },
  siteManagerSort('a sort under a module root', {
    orderperm: 'editor',
    topid: '00000000000000000000000000000000003',
    orderid: 'C1,C2',
  }),
  siteManagerSort('a sort under the home page', { orderperm: 'editor', topid: HOME_ID, orderid: 'C1,C2' }),
  siteManagerSort('a folder sort with a trailing-space home id', {
    orderperm: 'editor',
    topid: 'F1',
    orderid: `C1,${HOME_ID} ,C2`,
  }),
  siteManagerSort('a sort with an empty topid', { orderperm: 'editor', topid: '', orderid: 'C1,C2' }),
  siteManagerSort('a sort without a topid', { orderperm: 'editor', orderid: 'C1,C2' }),
  { label: 'a change set rollback', circuit: 'cChangesets', action: 'rollback', rc: { changesetid: 'CS-1' } },
  { label: 'class extensions', circuit: 'cextend', action: 'listsubtypes', rc: {} },
  { label: 'trash', circuit: 'ctrash', action: 'list', rc: {} },
  { label: 'the email broadcaster', circuit: 'cemail', action: 'list', rc: {} },
  { label: 'the dashboard', circuit: 'cdashboard', action: 'main', rc: {} },
  { label: 'the file manager', circuit: 'cfilemanager', action: 'default', rc: {} },
];

/** A findScreen request and the registered key and owner that serve it. */
interface ResolvedCase extends LookupCase {
  readonly key: string;
  readonly owner: string;
}

const RESOLVED: readonly ResolvedCase[] = [
  {
    label: 'a group save',
    circuit: 'cusers',
    action: 'update',
    rc: { type: '1' },
    key: 'admin:cusers.update{type=1}',
    owner: 'identity',
  },
  {
    label: 'a roster create',
    circuit: 'cusers',
    action: 'update',
    rc: { type: '2', action: 'Add' },
    key: 'admin:cusers.update{type=2,action=add}',
    owner: 'people',
  },
  {
    label: 'an MFA challenge on the login action',
    circuit: 'clogin',
    action: 'login',
    rc: { status: 'challenge', attemptChallenge: 'true' },
    key: 'admin:clogin.login',
    owner: 'identity',
  },
  {
    label: 'a failed-login notice on the login page',
    circuit: 'clogin',
    action: 'main',
    rc: { status: 'failed' },
    key: 'admin:clogin.main',
    owner: 'identity',
  },
  {
    label: 'the home redirect',
    circuit: 'home',
    action: 'redirect',
    rc: {},
    key: 'admin:home.redirect',
    owner: 'identity',
  },
  {
    label: 'an approval rejection',
    circuit: 'carch',
    action: 'approvalaction',
    rc: { action: 'reject' },
    key: 'admin:carch.approvalaction',
    owner: 'strategies-content',
  },
  ...[
    siteManagerSort('a folder sort', { orderperm: 'editor', topid: 'F1', orderid: 'C1,C2' }),
    siteManagerSort('a folder sort with a leading-space home id', {
      orderperm: 'editor',
      topid: 'F1',
      orderid: `C1, ${HOME_ID}`,
    }),
    siteManagerSort('a home page list without a sort permission', { topid: HOME_ID, orderid: 'C1,C2' }),
  ].map((lookup) => ({ ...lookup, key: 'admin:carch.list', owner: 'strategies-content' })),
  {
    label: 'a collection save outside compact display',
    circuit: 'cfeed',
    action: 'update',
    rc: { feedID: 'F-1', action: 'update', closeCompactDisplay: 'false' },
    key: 'admin:cfeed.update',
    owner: 'strategies-content',
  },
  {
    label: 'a form import without an upload',
    circuit: 'cform',
    action: 'importform',
    rc: { formzip: '' },
    uploads: [],
    key: 'admin:cform.importform',
    owner: 'strategies-content',
  },
  {
    label: 'a subsystem-qualified action',
    circuit: 'core:cUsers',
    action: 'listUsers',
    rc: {},
    key: 'admin:cusers.listusers',
    owner: 'people',
  },
];

const PAGE_SAMPLE: ReadonlyArray<readonly [string, string]> = [
  ['clogin', 'main'],
  ['cusers', 'listusers'],
  ['csettings', 'list'],
  ['carch', 'list'],
  ['cchain', 'list'],
];

/** Route key a not-built variant refuses, as routeKeyOf builds a definition's. */
const notBuiltKey = (variant: NotBuiltVariant): string =>
  normaliseRouteKey(`admin:${variant.circuit}.${variant.action}{${variant.key}}`);

describe('findScreen', () => {
  it.each(REFUSED)('refuses $label', ({ circuit, action, rc, uploads }) => {
    expect(findScreen(circuit, action, rc, uploads)).toBeUndefined();
  });

  it('lists the forgot-password, photo, roster delete, image upload, approval and shared-id sort refusals', () => {
    expect(NOT_BUILT_VARIANTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ circuit: 'clogin', action: 'main', key: 'status=sendlogin' }),
        expect.objectContaining({ circuit: 'clogin', action: 'login', key: 'status=sendlogin' }),
        expect.objectContaining({ circuit: 'cusers', action: 'update', key: 'photo' }),
        expect.objectContaining({ circuit: 'ceditprofile', action: 'update', key: 'photo' }),
        expect.objectContaining({ circuit: 'cusers', action: 'update', key: 'type=2,action=delete' }),
        expect.objectContaining({ circuit: 'carch', action: 'update', key: 'upload=image' }),
        expect.objectContaining({ circuit: 'carch', action: 'approvalaction', key: 'action=approve' }),
        expect.objectContaining({ circuit: 'carch', action: 'list', key: 'sharedid' }),
      ]),
    );
  });


  it('lists every withheld or halted variant of an action web registers', () => {
    const registeredActions = new Set(DEFS.map((def) => `admin:${def.circuit}.${def.action}`));
    const listed = new Set(NOT_BUILT_VARIANTS.map(notBuiltKey));
    const unlisted = [...RECORDS.values()]
      .filter((r) => r.routeKey.includes('{') && (!isCarried(r) || HALTED.has(r.routeKey)))
      .map((r) => r.routeKey)
      .filter((key) => registeredActions.has(key.slice(0, key.indexOf('{'))) && !listed.has(key));
    expect(unlisted).toEqual([]);
  });

  it('refuses no carried variant but the halted ones', () => {
    const refusedCarry = NOT_BUILT_VARIANTS.map(notBuiltKey).filter((key) => CARRIED.includes(key) && !HALTED.has(key));
    expect(refusedCarry).toEqual([]);
  });

  it.each(RESOLVED)('resolves $label', ({ circuit, action, rc, uploads, key, owner }) => {
    const def = findScreen(circuit, action, rc, uploads);
    expect(def).toBeDefined();
    expect(def).toBe(defOf(key));
    expect(def?.owner).toBe(owner);
  });

  it.each(PAGE_SAMPLE)('returns the registered %s.%s definition', (circuit, action) => {
    const def = DEFS.find((candidate) => candidate.circuit === circuit && candidate.action === action);
    expect(def?.mode).toBe('page');
    expect(findScreen(circuit, action, {})).toBe(def);
  });
});

describe('shell hooks', () => {
  it('supplies the four secondary menus', () => {
    expect(Object.keys(shellHooks.secondaryMenus).toSorted()).toEqual(['carch', 'ccategory', 'cchangesets', 'cfeed']);
  });

  it('supplies each circuit menu and the content nav', () => {
    expect(shellHooks.secondaryMenus.carch).toBe(carchSecondaryMenu);
    expect(shellHooks.secondaryMenus.cchangesets).toBe(cchangesetsSecondaryMenu);
    expect(shellHooks.secondaryMenus.ccategory).toBe(ccategorySecondaryMenu);
    expect(shellHooks.secondaryMenus.cfeed).toBe(cfeedSecondaryMenu);
    expect(shellHooks.contentNav).toBe(carchContentNav);
  });
});
