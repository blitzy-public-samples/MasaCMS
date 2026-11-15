// The screen registry against the inventory's admin dispositions: carried actions served once, nothing else served.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import { carchContentNav } from '@/screens/carch/content-nav';
import { carchSecondaryMenu } from '@/screens/carch/secondary-menu';
import { ccategorySecondaryMenu } from '@/screens/ccategory/secondary-menu';
import { cchangesetsSecondaryMenu } from '@/screens/cchangesets/secondary-menu';
import { cfeedSecondaryMenu } from '@/screens/cfeed/secondary-menu';
import { cloginScreens } from '@/screens/clogin';
import { homeRedirectScreen } from '@/screens/clogin/home-redirect';
import {
  NOT_BUILT_VARIANTS,
  allOpt2Actions,
  allOpt2Screens,
  allScreens,
  findOpt2Action,
  findOpt2Screen,
  findScreen,
  routeKeyOf,
  shellHooks,
  type NotBuiltVariant,
  type Rc,
  type ScreenDefinition,
  type UploadPart,
} from '@/screens/registry';
import { OPT2_NAV_MODULES } from '@/shell/nav';

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

// The variant-less approvalaction definition reads `action` itself, so it also answers the carried approve variant.
const ANSWERED_BY_BASE: ReadonlyArray<UnregisteredCarry & { readonly base: string }> = [
  {
    key: normaliseRouteKey('admin:carch.approvalaction{action=approve}'),
    base: normaliseRouteKey('admin:carch.approvalaction'),
    circuit: 'carch',
    action: 'approvalaction',
    rc: { action: 'approve' },
  },
];

// No programs-sites screen serves updateSite's residual branch (its Update branch writes the withheld
// trazunasettings) or the withheld site copy's result page, so both stay on legacy.
const KEPT_ON_LEGACY: readonly UnregisteredCarry[] = [
  { key: normaliseRouteKey('admin:csettings.updatesite'), circuit: 'csettings', action: 'updatesite', rc: {} },
  { key: normaliseRouteKey('admin:csettings.sitecopyresult'), circuit: 'csettings', action: 'sitecopyresult', rc: {} },
];

// cwebservice edit is a carried identity action the inventory folds into save.cfm, which includes edit.cfm.
const NOT_INVENTORIED: readonly string[] = [normaliseRouteKey('admin:cwebservice.edit')];

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
    const unregistered = new Set([
      ...HALTED,
      ...ANSWERED_BY_BASE.map((entry) => entry.key),
      ...KEPT_ON_LEGACY.map((entry) => entry.key),
    ]);
    const missing = CARRIED.filter(
      (key) => !unregistered.has(key) && REGISTERED.filter((registered) => registered === key).length !== 1,
    );
    expect(missing).toEqual([]);
  });

  it('registers only carried inventory keys', () => {
    const stray = REGISTERED.filter((key) => {
      const record = RECORDS.get(key);
      return record === undefined ? !NOT_INVENTORIED.includes(key) : !isCarried(record);
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
    expect([...HALTED]).toEqual(expect.arrayContaining([normaliseRouteKey('admin:carch.cropimage')]));
    expect(registeredOf(HALTED)).toEqual([]);
  });

  it.each(ANSWERED_BY_BASE)('answers $key with its base definition', ({ key, base, circuit, action, rc }) => {
    expect(CARRIED).toContain(key);
    expect(registeredOf([key])).toEqual([]);
    expect(defOf(base)).toBeDefined();
    expect(findScreen(circuit, action, rc)).toBe(defOf(base));
  });

  it.each(KEPT_ON_LEGACY)('keeps $key on legacy', ({ key, circuit, action, rc }) => {
    expect(CARRIED).toContain(key);
    expect(registeredOf([key])).toEqual([]);
    expect(findScreen(circuit, action, rc)).toBeUndefined();
  });

  it.each(NOT_INVENTORIED)('registers the uninventoried %s once for identity', (key) => {
    expect(RECORDS.has(key)).toBe(false);
    expect(REGISTERED.filter((registered) => registered === key)).toEqual([key]);
    expect(defOf(key)).toMatchObject({ mode: 'page', owner: 'identity' });
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

const REFUSED: readonly LookupCase[] = [
  { label: 'a roster delete', circuit: 'cusers', action: 'update', rc: { type: '2', action: 'Delete' } },
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
    label: 'a roster edit',
    circuit: 'cusers',
    action: 'update',
    rc: { type: '2', action: 'Update' },
    key: 'admin:cusers.update{type=2,action=update}',
    owner: 'people',
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
    label: 'a non-image upload',
    circuit: 'carch',
    action: 'update',
    rc: { newfile: 'doc.pdf' },
    uploads: [{ field: 'newfile', filename: 'doc.pdf' }],
    key: 'admin:carch.update',
    owner: 'strategies-content',
  },
  {
    label: 'a profile save',
    circuit: 'ceditprofile',
    action: 'update',
    rc: {},
    key: 'admin:ceditprofile.update',
    owner: 'people',
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

  it('lists the photo, roster delete and image upload refusals', () => {
    expect(NOT_BUILT_VARIANTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ circuit: 'cusers', action: 'update', key: 'photo' }),
        expect.objectContaining({ circuit: 'ceditprofile', action: 'update', key: 'photo' }),
        expect.objectContaining({ circuit: 'cusers', action: 'update', key: 'type=2,action=delete' }),
        expect.objectContaining({ circuit: 'carch', action: 'update', key: 'upload=image' }),
      ]),
    );
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

/** Screen and action slugs of a synthetic module. */
interface ModuleSlugs {
  readonly screens: readonly string[];
  readonly actions: readonly string[];
}

const OPT2_SLUGS: Readonly<Record<string, ModuleSlugs>> = {
  communications: { screens: ['templates', 'sends', 'delivery-status'], actions: ['save-template', 'send'] },
  'e-signature': { screens: ['requests', 'request', 'audit', 'verify'], actions: ['create-request', 'sign', 'verify'] },
  finance: {
    screens: ['records', 'record'],
    actions: ['submit', 'resubmit', 'approve', 'reject', 'edit', 'upload', 'download'],
  },
  reporting: { screens: ['exports'], actions: ['queue', 'download'] },
  surveys: { screens: ['surveys', 'schedule', 'targets', 'responses'], actions: ['schedule', 'bulk-target'] },
  timesheets: { screens: ['sheets', 'sheet'], actions: ['day-action'] },
};

/** Sorted slugs of `defs` per module. */
function slugsByModule<T extends { readonly module: string }>(defs: readonly T[], slugOf: (def: T) => string) {
  const table: Record<string, string[]> = {};
  for (const def of defs) (table[def.module] ??= []).push(slugOf(def));
  return Object.fromEntries(Object.entries(table).map(([module, slugs]) => [module, slugs.toSorted()]));
}

describe('OPT-2 lookups', () => {
  it.each(OPT2_NAV_MODULES)('resolves the $module nav link', ({ module, screen }) => {
    expect(findOpt2Screen(module, screen)).toMatchObject({ module, screen });
  });

  it('finds every synthetic screen and action by its slug', () => {
    expect(allOpt2Screens().filter((def) => findOpt2Screen(def.module, def.screen) !== def)).toEqual([]);
    expect(allOpt2Actions().filter((def) => findOpt2Action(def.module, def.action) !== def)).toEqual([]);
  });

  it('registers the six synthetic modules', () => {
    const modules = new Set([...allOpt2Screens(), ...allOpt2Actions(), ...OPT2_NAV_MODULES].map((def) => def.module));
    expect([...modules].toSorted()).toEqual([
      'communications',
      'e-signature',
      'finance',
      'reporting',
      'surveys',
      'timesheets',
    ]);
  });

  it('registers each module screen and action slug', () => {
    const sorted = (pick: 'screens' | 'actions') =>
      Object.fromEntries(Object.entries(OPT2_SLUGS).map(([module, slugs]) => [module, slugs[pick].toSorted()]));
    expect(slugsByModule(allOpt2Screens(), (def) => def.screen)).toEqual(sorted('screens'));
    expect(slugsByModule(allOpt2Actions(), (def) => def.action)).toEqual(sorted('actions'));
  });

  it.each([
    ['screen', () => findOpt2Screen('timesheets', 'nope')],
    ['module', () => findOpt2Screen('payroll', 'sheets')],
    ['action', () => findOpt2Action('finance', 'approve-all')],
  ] as const)('finds nothing for an unknown %s', (_kind, lookup) => {
    expect(lookup()).toBeUndefined();
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
