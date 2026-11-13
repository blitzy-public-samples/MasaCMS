// Admin screen contracts, the registered screens with their lookups, and the shell hooks screens supply (server-only).
import type { Role } from '@opt2/platform/auth';
import {
  IMAGE_UPLOAD_CONDITION,
  PHOTO_CONDITION,
  cfEq,
  cfIsBoolean,
  cfToBoolean,
  type VariantCondition,
} from '@opt2/platform/legacy-compat';
import type { ScreenGate } from '@/lib/access-gate';
import type { CsrfRenderer } from '@/lib/csrf';
import type { GatewayClient, WebServiceName } from '@/lib/gateway-client';
import type { SafeHtml } from '@/lib/html';
import type { RequestBody } from '@/lib/request-body';
import type { AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { SecondaryMenuCircuit, ShellHooks, ShellView } from '@/shell/document';
import { OPT2_NAV_MODULES } from '@/shell/nav';
import { carchContentNav, carchScreens, carchSecondaryMenu } from './carch';
import { ccategoryScreens, ccategorySecondaryMenu } from './ccategory';
import { cchainScreens } from './cchain';
import { cchangesetsScreens, cchangesetsSecondaryMenu } from './cchangesets';
import { ccommentsScreens } from './ccomments';
import { ceditprofileScreens } from './ceditprofile';
import { cfeedScreens, cfeedSecondaryMenu } from './cfeed';
import { cformScreens } from './cform';
import { cloginScreens } from './clogin';
import { cmessageScreens } from './cmessage';
import { cnavScreens } from './cnav';
import { cpermScreens } from './cperm';
import { csettingsScreens } from './csettings';
import { cusersScreens } from './cusers';
import { cwebserviceScreens } from './cwebservice';
import { opt2Actions, opt2Screens } from './opt2';

// ---- Contracts ----

/** Inventoried response mode of an admin action, which picks its web handler. */
export type ScreenMode = 'page' | 'fragment' | 'json' | 'download' | 'redirect';

/** Migrated service that owns an admin action. */
export type ScreenOwner = 'identity' | 'people' | 'programs-sites' | 'strategies-content';

/** FW/1 request context a screen reads. */
export type Rc = AdminRequest['rc'];

/** A redirect- or raw-mode request body as web received it. */
export type ScreenRequestBody = RequestBody;

/** Everything a screen receives for one request. */
export interface ScreenContext {
  /** FW/1-merged rc, session, site, user and flags. */
  req: AdminRequest;
  /** The only data path: service calls through the gateway. */
  gateway: GatewayClient;
  /** Renders tokens fetched from identity; never validates. */
  csrf: CsrfRenderer;
  /** Admin bundle of `session.rb`. */
  rb: RbLookup;
  /** Lets a view embed a secondary menu at its legacy include point. */
  hooks: ShellHooks;
  /** Injectable clock. */
  now: Date;
  /** The request body; absent in page mode and on requests without one. */
  body?: ScreenRequestBody;
}

/** Request-decidable branch of an action; `key` as in the route key, e.g. `type=2,action=add`. */
export interface ScreenVariant {
  key: string;
  matches(rc: Rc): boolean;
}

/** A bare response body, byte-shaped like legacy's. */
export interface RawBody {
  /** Defaults to 200. */
  status?: number;
  /** The legacy content type, exactly. */
  contentType: string;
  body: string | SafeHtml | Uint8Array;
  /** For example `Content-Disposition` of a download. */
  headers?: Record<string, string>;
  setCookies?: string[];
}

/** Service `Set-Cookie` values a submit outcome relays unchanged and in order, sent after the request set-up's own. */
interface RelayedCookies {
  setCookies?: readonly string[];
}

/** Outcome of a redirect-mode action. */
export type SubmitResult =
  /** FW/1 `redirect()`. */
  | ({
      kind: 'redirect';
      action: string;
      append?: string;
      preserve?: string;
      path?: string;
      queryString?: string;
      /** Values the controller set on `rc` before redirecting; `append` and `preserve` read them over the request's. */
      rc?: Readonly<Record<string, string>>;
    } & RelayedCookies)
  /** `cflocation`, or a service `Location` passed through. */
  | ({ kind: 'location'; location: string } & RelayedCookies)
  /** Validation re-render inside the shell. */
  | ({ kind: 'render'; view: ShellView; status?: number } & RelayedCookies)
  /** An action that writes, then emits a bare body. */
  | { kind: 'raw'; response: RawBody };

interface ScreenBase<D> {
  /** Lower-case, e.g. `cusers`; `home` for `home.redirect`. */
  circuit: string;
  /** Lower-case FW/1 item, e.g. `edituser`. */
  action: string;
  variant?: ScreenVariant;
  owner: ScreenOwner;
  /** The controller `before()` rule, built with `secure()` from `@/lib/access-gate`; absent when it gates nothing. */
  gate?: ScreenGate;
  /** The circuit menu this view embeds. */
  secondaryMenu?: SecondaryMenuCircuit;
  load?(ctx: ScreenContext): Promise<D>;
}

/** FW/1 `redirect()` a page action's controller issues instead of rendering its view. */
export type PageRedirect = Extract<SubmitResult, { kind: 'redirect' }>;

/** A page controller's answer instead of its view: an FW/1 `redirect()`, or a `cflocation` such as a service's. */
export type PageControllerRedirect = PageRedirect | Extract<SubmitResult, { kind: 'location' }>;

/** A view rendered inside the shell. */
export interface PageScreen<D = unknown> extends ScreenBase<D> {
  mode: 'page';
  /**
   * Controller step evaluated after the gate and before `load`; a result answers with that redirect instead. It may
   * call services first, as a controller that writes and then redirects does.
   */
  redirect?(ctx: ScreenContext): PageControllerRedirect | undefined | Promise<PageControllerRedirect | undefined>;
  render(ctx: ScreenContext, data: D): ShellView | Promise<ShellView>;
}

/** Bare markup without the shell (`request.layout=false`). */
export interface FragmentScreen<D = unknown> extends ScreenBase<D> {
  mode: 'fragment';
  render(ctx: ScreenContext, data: D): RawBody | Promise<RawBody>;
}

/** A JSON body (`cfcontent` plus `cfabort`). */
export interface JsonScreen<D = unknown> extends ScreenBase<D> {
  mode: 'json';
  json(ctx: ScreenContext, data: D): RawBody | Promise<RawBody>;
}

/** A file with legacy's download headers. */
export interface DownloadScreen<D = unknown> extends ScreenBase<D> {
  mode: 'download';
  download(ctx: ScreenContext, data: D): RawBody | Promise<RawBody>;
}

/** A post action that writes, then redirects or re-renders. */
export interface RedirectScreen extends ScreenBase<never> {
  mode: 'redirect';
  submit(ctx: ScreenContext): Promise<SubmitResult>;
}

/** Any reproduced admin action. */
export type ScreenDefinition =
  | PageScreen<any>
  | FragmentScreen<any>
  | JsonScreen<any>
  | DownloadScreen<any>
  | RedirectScreen;

/** Synthetic module with screens under `/opt2/admin/<module>/<screen>`. */
export type Opt2Module = 'timesheets' | 'finance' | 'e-signature' | 'reporting' | 'surveys' | 'communications';

/** A synthetic-module screen rendered inside the shell. */
export interface Opt2ScreenDefinition<D = any> {
  module: Opt2Module;
  screen: string;
  roles: readonly Role[];
  service: WebServiceName;
  /** Check run after the application gate; without one, access is the owning service's decision. */
  gate?: ScreenGate;
  load(ctx: ScreenContext): Promise<D>;
  render(ctx: ScreenContext, data: D): ShellView | Promise<ShellView>;
}

/** A synthetic-module post action. */
export interface Opt2ActionDefinition {
  module: Opt2Module;
  action: string;
  roles: readonly Role[];
  service: WebServiceName;
  /** Check run after the application gate; without one, access is the owning service's decision. */
  gate?: ScreenGate;
  submit(ctx: ScreenContext): Promise<SubmitResult>;
}

/** A multipart file part as the request carried it. */
export interface UploadPart {
  readonly field: string;
  readonly filename: string;
}

// ---- Variant conditions ----

/** `rc` value by case-insensitive name, as a CFML scope reads it. */
function rcValue(rc: Rc, name: string): string | undefined {
  if (Object.hasOwn(rc, name)) return rc[name];
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

// rc reads a file part as its file name but cannot tell it from a text field, so without the parts every rc value
// (each `,` item, since a scope joins repeated names) counts as one, and an upload web cannot rule out stays unserved.
/** The request's file parts, or every rc value as a possible one. */
function filePartsOf(rc: Rc, uploads: readonly UploadPart[] | undefined): readonly UploadPart[] {
  if (uploads !== undefined) return uploads;
  return Object.entries(rc).flatMap(([field, value]) => value.split(',').map((filename) => ({ field, filename })));
}

/** A route-key variant condition over `rc` and the file parts, compared as legacy compares (case-insensitively). */
function holds(cond: VariantCondition, rc: Rc, files: readonly UploadPart[]): boolean {
  if ('anyOf' in cond) return cond.anyOf.some((c) => holds(c, rc, files));
  if ('not' in cond) return !holds(cond.not, rc, files);
  if ('multipartExtensionIn' in cond) {
    const extensions = new Set(cond.multipartExtensionIn.map((e) => e.toLowerCase()));
    return files.some(({ filename }) => {
      const dot = filename.lastIndexOf('.');
      return dot >= 0 && extensions.has(filename.slice(dot + 1).toLowerCase());
    });
  }
  const value = rcValue(rc, cond.param);
  if ('equals' in cond) return value !== undefined && cfEq(value, cond.equals);
  if ('in' in cond) return value !== undefined && cond.in.some((candidate) => cfEq(value, candidate));
  if ('nonEmpty' in cond) {
    const name = cond.param.toLowerCase();
    return (value ?? '').length > 0 || files.some((f) => f.field.toLowerCase() === name && f.filename.length > 0);
  }
  return value !== undefined && cfIsBoolean(value) && cfToBoolean(value);
}

/** A withheld or halted branch of an action; web never serves it and the gateway keeps it on legacy. */
export interface NotBuiltVariant {
  readonly circuit: string;
  readonly action: string;
  readonly key: string;
  /** `uploads`: the request's multipart file parts, when the caller has them. */
  matches(rc: Rc, uploads?: readonly UploadPart[]): boolean;
}

const equals = (param: string, value: string): VariantCondition => ({ param, equals: value });
const nonEmpty = (param: string): VariantCondition => ({ param, nonEmpty: true });
const truthy = (param: string): VariantCondition => ({ param, truthy: true });
const EXTENDED_DATA = nonEmpty('extendSetID');

function notBuilt(circuit: string, action: string, key: string, ...when: readonly VariantCondition[]): NotBuiltVariant {
  return Object.freeze({
    circuit,
    action,
    key,
    matches: (rc: Rc, uploads?: readonly UploadPart[]): boolean => {
      const files = filePartsOf(rc, uploads);
      return when.every((cond) => holds(cond, rc, files));
    },
  });
}

// Every withheld or halted variant declared for an action web registers, with the gateway's conditions; a registered
// base must never answer a request that one of these matches.
/** Branches evaluated before any registered variant; a match means web does not serve the request. */
export const NOT_BUILT_VARIANTS: readonly NotBuiltVariant[] = Object.freeze([
  notBuilt('cusers', 'update', 'photo', PHOTO_CONDITION),
  notBuilt(
    'cusers',
    'update',
    'type=2,action=add,extdata',
    equals('type', '2'),
    equals('action', 'Add'),
    EXTENDED_DATA,
  ),
  notBuilt(
    'cusers',
    'update',
    'type=2,action=update,extdata',
    equals('type', '2'),
    equals('action', 'Update'),
    EXTENDED_DATA,
  ),
  notBuilt('cusers', 'update', 'type=1,action=delete', equals('type', '1'), equals('action', 'Delete')),
  notBuilt('cusers', 'update', 'type=1,extdata', equals('type', '1'), EXTENDED_DATA),
  notBuilt('cusers', 'update', 'type=2,action=delete', equals('type', '2'), equals('action', 'Delete')),
  notBuilt('cusers', 'updateaddress', 'action=delete', equals('action', 'Delete')),
  notBuilt('cusers', 'updateaddress', 'extdata', { anyOf: [EXTENDED_DATA, equals('extendSetID', '')] }),
  notBuilt('ceditprofile', 'update', 'photo', PHOTO_CONDITION),
  notBuilt('ceditprofile', 'update', 'extdata', EXTENDED_DATA),
  notBuilt('csettings', 'updatesite', 'bundle', { anyOf: [nonEmpty('bundleFile'), nonEmpty('serverBundlePath')] }),
  notBuilt('csettings', 'updatesite', 'action=add', equals('action', 'Add')),
  notBuilt('csettings', 'updatesite', 'action=delete', equals('action', 'Delete')),
  notBuilt('csettings', 'updatesite', 'action=update', equals('action', 'Update')),
  // The core auto-updater rewrites the legacy web root, so this branch of the carried list stays legacy-served.
  notBuilt('csettings', 'list', 'action=updatecore', equals('action', 'updateCore')),
  notBuilt('carch', 'update', 'upload=image', IMAGE_UPLOAD_CONDITION),
  notBuilt('carch', 'update', 'approved=1', truthy('approved')),
  notBuilt('carch', 'update', 'notify', nonEmpty('notify')),
  notBuilt('carch', 'multifileupload', 'upload=image', IMAGE_UPLOAD_CONDITION),
  notBuilt('carch', 'updateobjectparams', 'approved=1', truthy('approved')),
  notBuilt('carch', 'variationtargeting', 'notify', nonEmpty('notify')),
]);


// ---- Registry ----

/** Route key of a screen: `admin:<circuit>.<action>`, plus `{<variant key>}` for a variant, lower-case. */
export function routeKeyOf(def: ScreenDefinition): string {
  const variant = def.variant === undefined ? '' : `{${def.variant.key}}`;
  return `admin:${def.circuit}.${def.action}${variant}`.toLowerCase();
}

/** The function a definition of each mode must carry. */
const MODE_FUNCTIONS: Readonly<Record<string, string>> = Object.freeze({
  page: 'render',
  fragment: 'render',
  json: 'json',
  download: 'download',
  redirect: 'submit',
});

/** Throws unless `def` names a lower-case circuit and action and carries its mode's function. */
function assertWellFormed(def: ScreenDefinition, key: string): void {
  if (def.circuit !== def.circuit.toLowerCase() || def.action !== def.action.toLowerCase()) {
    throw new Error(`Screen ${def.circuit}.${def.action} must name a lower-case circuit and action`);
  }
  const needed = MODE_FUNCTIONS[def.mode];
  if (needed === undefined || typeof (def as unknown as Readonly<Record<string, unknown>>)[needed] !== 'function') {
    throw new TypeError(`Screen ${key} of mode '${String(def.mode)}' has no ${needed ?? 'known mode'} function`);
  }
}

/** Condition count of a screen's variant key; 0 for the variant-less definition. */
function specificity(def: ScreenDefinition): number {
  return def.variant === undefined ? 0 : def.variant.key.split(',').length;
}

const actionKey = (circuit: string, action: string): string => `${circuit}.${action}`;

const opt2Key = (module: string, slug: string): string => `${module}/${slug}`.toLowerCase();

/** `entries` keyed by `keyOf`; throws on a repeated key. */
function indexUnique<T>(entries: readonly T[], keyOf: (entry: T) => string, kind: string): ReadonlyMap<string, T> {
  const table = new Map<string, T>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (table.has(key)) throw new Error(`Duplicate ${kind} registration: ${key}`);
    table.set(key, entry);
  }
  return table;
}

/** `entries` grouped by `keyOf`, each group in input order. */
function groupBy<T>(entries: Iterable<T>, keyOf: (entry: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  return groups;
}

const NOT_BUILT_BY_ACTION: ReadonlyMap<string, readonly NotBuiltVariant[]> = groupBy(NOT_BUILT_VARIANTS, (variant) =>
  actionKey(variant.circuit, variant.action),
);

/** Definitions a registry is built from. */
export interface ScreenRegistryInput {
  readonly screens: readonly ScreenDefinition[];
  readonly opt2Screens: readonly Opt2ScreenDefinition[];
  readonly opt2Actions: readonly Opt2ActionDefinition[];
  /** OPT-2 nav links; each must resolve to a registered screen. */
  readonly navModules: ReadonlyArray<{ readonly module: string; readonly screen: string }>;
}

/** Lookups over one set of registered screens. */
export interface ScreenRegistry {
  /**
   * The screen serving `circuit.action` for `rc`: undefined when a not-built variant matches, else the most specific
   * matching variant, else the variant-less definition, else undefined.
   * @param circuit FW/1 section, in any case, with or without the `core:` subsystem.
   * @param uploads The request's multipart file parts; without them every rc value counts as a possible file name.
   */
  findScreen(circuit: string, action: string, rc: Rc, uploads?: readonly UploadPart[]): ScreenDefinition | undefined;
  /** The synthetic screen at `/opt2/admin/<module>/<screen>`, matched lower-case. */
  findOpt2Screen(module: string, screen: string): Opt2ScreenDefinition | undefined;
  /** The synthetic post action `<module>/<action>`, matched lower-case. */
  findOpt2Action(module: string, action: string): Opt2ActionDefinition | undefined;
  /** Every admin screen, in registration order. */
  allScreens(): readonly ScreenDefinition[];
  /** Every synthetic screen, in registration order. */
  allOpt2Screens(): readonly Opt2ScreenDefinition[];
  /** Every synthetic post action, in registration order. */
  allOpt2Actions(): readonly Opt2ActionDefinition[];
}

/**
 * Validates and indexes `input`.
 * @throws Error On a repeated route key or OPT-2 slug, a circuit or action not lower-case, or an unresolved nav link.
 * @throws TypeError On a definition without the function its mode needs.
 */
export function createScreenRegistry(input: ScreenRegistryInput): ScreenRegistry {
  const byRouteKey = indexUnique(
    input.screens,
    (def) => {
      const key = routeKeyOf(def);
      assertWellFormed(def, key);
      return key;
    },
    'screen',
  );
  const byAction = new Map<string, readonly ScreenDefinition[]>();
  for (const [key, defs] of groupBy(byRouteKey.values(), (def) => actionKey(def.circuit, def.action))) {
    byAction.set(key, Object.freeze(defs.toSorted((a, b) => specificity(b) - specificity(a))));
  }
  const opt2ScreenTable = indexUnique(input.opt2Screens, (def) => opt2Key(def.module, def.screen), 'OPT-2 screen');
  const opt2ActionTable = indexUnique(input.opt2Actions, (def) => opt2Key(def.module, def.action), 'OPT-2 action');
  for (const { module, screen } of input.navModules) {
    if (!opt2ScreenTable.has(opt2Key(module, screen))) {
      throw new Error(`OPT-2 nav link ${module}/${screen} has no registered screen`);
    }
  }
  const screens = Object.freeze([...input.screens]);
  const opt2Screens = Object.freeze([...input.opt2Screens]);
  const opt2Actions = Object.freeze([...input.opt2Actions]);

  return Object.freeze({
    findScreen(circuit: string, action: string, rc: Rc, uploads?: readonly UploadPart[]): ScreenDefinition | undefined {
      const key = actionKey(circuit.toLowerCase().replace(/^core:/, ''), action.toLowerCase());
      if (NOT_BUILT_BY_ACTION.get(key)?.some((variant) => variant.matches(rc, uploads))) return undefined;
      return byAction.get(key)?.find((def) => def.variant === undefined || def.variant.matches(rc));
    },
    findOpt2Screen: (module: string, screen: string) => opt2ScreenTable.get(opt2Key(module, screen)),
    findOpt2Action: (module: string, action: string) => opt2ActionTable.get(opt2Key(module, action)),
    allScreens: () => screens,
    allOpt2Screens: () => opt2Screens,
    allOpt2Actions: () => opt2Actions,
  });
}

const registry = createScreenRegistry({
  screens: [
    ...cloginScreens,
    ...cmessageScreens,
    ...cusersScreens,
    ...ceditprofileScreens,
    ...cpermScreens,
    ...cwebserviceScreens,
    ...csettingsScreens,
    ...carchScreens,
    ...cchangesetsScreens,
    ...ccommentsScreens,
    ...ccategoryScreens,
    ...cfeedScreens,
    ...cformScreens,
    ...cchainScreens,
    ...cnavScreens,
  ],
  opt2Screens,
  opt2Actions,
  navModules: OPT2_NAV_MODULES,
});

/** {@link ScreenRegistry.findScreen} over the reproduced admin screens. */
export const findScreen: ScreenRegistry['findScreen'] = registry.findScreen;

/** {@link ScreenRegistry.findOpt2Screen} over the synthetic-module screens. */
export const findOpt2Screen: ScreenRegistry['findOpt2Screen'] = registry.findOpt2Screen;

/** {@link ScreenRegistry.findOpt2Action} over the synthetic-module post actions. */
export const findOpt2Action: ScreenRegistry['findOpt2Action'] = registry.findOpt2Action;

/** Every reproduced admin screen. */
export const allScreens: ScreenRegistry['allScreens'] = registry.allScreens;

/** Every synthetic-module screen. */
export const allOpt2Screens: ScreenRegistry['allOpt2Screens'] = registry.allOpt2Screens;

/** Every synthetic-module post action. */
export const allOpt2Actions: ScreenRegistry['allOpt2Actions'] = registry.allOpt2Actions;

// ---- Shell hooks ----

/** Circuit fragments the shell embeds: the secondary menus and the cArch content nav. */
export const shellHooks: ShellHooks = Object.freeze({
  secondaryMenus: Object.freeze({
    carch: carchSecondaryMenu,
    cchangesets: cchangesetsSecondaryMenu,
    ccategory: ccategorySecondaryMenu,
    cfeed: cfeedSecondaryMenu,
  }),
  contentNav: carchContentNav,
});

