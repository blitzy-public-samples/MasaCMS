// Closed, cited list of the request facts that decide which conditional legacy writes a legacy-bound request reaches.
import { cfEq, cfIsBoolean, cfToBoolean, normaliseRouteKey, type RouteFamily, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { createWriteClosure } from '../cutover/build-groups.js';
import type { InventoryDoc, InventoryWrite, InventoryWriter, OwnershipDoc } from '../cutover/types.js';

/** Answers to the stored facts some guards read, which the request alone does not decide; an absent answer is not known yet. */
export interface RequestProbes {
  /** Whether an archive row of one of the request's {@link orphanArchiveFilenames} names no active content (migration `orphanArchiveProbe`). */
  readonly orphanArchive?: boolean;
  /** Whether legacy runs CFML for a static-family request rather than serving it a file (bridge `site.cfm?op=static`). */
  readonly cfml?: boolean;
}

/** A stored fact one probe answers. */
export type ProbeKind = keyof RequestProbes;

/** Per probe a request still waits on, the units its guarded writes add once the probe holds. */
export type PendingProbes = Partial<Record<ProbeKind, string[]>>;

/** Request facts the guards read. */
export interface RequestFacts {
  /** The request path before `?`, as sent. */
  readonly path: string;
  /** The route key's merged params, lower-cased names. */
  readonly params: Readonly<Record<string, string>>;
  /** The url scope as legacy's start-up leaves it, lower-cased names; the servlet event reads it before the form. */
  readonly url: Readonly<Record<string, string>>;
  /** The request-line method, never an `X-HTTP-Method-Override`. */
  readonly method: string;
  /** Request cookies, looked up without case. */
  readonly cookies: ReadonlyMap<string, string>;
  /** Whether legacy serves the request with session management (applicationSettings.cfm:179). */
  readonly sessionManaged: () => boolean;
  /** The probe answers obtained for the request so far. */
  readonly probes?: RequestProbes;
}

/** A request predicate without which legacy never reaches the writes whose call path starts with one of `vias`. */
export interface RequestGuard {
  readonly id: string;
  readonly vias: readonly (readonly string[])[];
  /** A superset of the legacy condition, so a request it rejects cannot reach the guarded writes. */
  readonly holds: (facts: RequestFacts) => boolean;
  /** The probe without whose answer `holds` cannot be decided for `facts`, if any. */
  readonly pending?: (facts: RequestFacts) => ProbeKind | undefined;
  readonly source: string;
}

/** A request writer the inventory reaches from no route key, because request start-up runs it before any entry point. */
export interface StartupWriter {
  /** The inventory writer's `override`. */
  readonly id: string;
  readonly holds: (family: RouteFamily, facts: RequestFacts) => boolean;
  /** The probe without whose answer `holds` cannot be decided for a request of `family`, if any. */
  readonly pending?: (family: RouteFamily, facts: RequestFacts) => ProbeKind | undefined;
  readonly source: string;
}

/** A Masa pipeline a legacy-bound request runs besides its own entry point, by the render guards it passes through. */
interface Pipeline {
  readonly applies: (key: Pick<RouteKeyResult, 'family' | 'baseKey'>) => boolean;
  readonly guards: readonly string[];
  readonly source: string;
}

/** Request-conditional legacy writes of the inventory, read per legacy-bound request. */
export interface RequestWrites {
  /** `units` of `route`'s entry less those only writes under a failing guard reach; `units` itself when none is dropped. */
  entryUnits(route: string, units: readonly string[], facts: RequestFacts): readonly string[];
  /** Units the render pipeline a request keyed `key` also runs writes under guards that hold. */
  pipelineUnits(key: Pick<RouteKeyResult, 'family' | 'baseKey'>, facts: RequestFacts): string[];
  /** Units request start-up writes for a request of `family`, such as a remember-me login. */
  startupUnits(family: RouteFamily, facts: RequestFacts): string[];
  /** The probes the pipeline of a request keyed `key` waits on, with the units each adds to {@link pipelineUnits} once it holds. */
  pipelineProbes(key: Pick<RouteKeyResult, 'family' | 'baseKey'>, facts: RequestFacts): PendingProbes;
  /** The probes request start-up waits on for a request of `family`, with the units each adds to {@link startupUnits} once it holds. */
  startupProbes(family: RouteFamily, facts: RequestFacts): PendingProbes;
}

/** The front-end render route, whose handlers every page request runs (contentServer.cfc:857-922). */
export const RENDER_ROUTE = 'page:render';

const ASYNC_OBJECT = 'jsonApiUtility.processAsyncObject';
const ASYNC_ROUTES: ReadonlySet<string> = new Set(['api:processasyncobject', 'rest:processasyncobject']);
const MAGIC_LINK_GUARD = 'magic-link-login';
/** Families start-up writes are not windowed for: target-served OPT-2 paths and the gateway-only bridge. */
const NO_STARTUP_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['opt2', 'bridge']);

/** Most candidate filenames one orphan archive probe sends (`OrphanArchiveProbeRequest`). */
export const ORPHAN_ARCHIVE_MAX_FILENAMES = 1000;
/** Longest candidate filename one orphan archive probe sends (`OrphanArchiveProbeRequest`). */
export const ORPHAN_ARCHIVE_MAX_FILENAME_LENGTH = 4000;
// The filename render404 renders, whatever the request names (contentServer.cfc:505-510).
const RENDER_404_FILENAME = '404';
// Allowed index files (configBean allowedIndexFiles) contentServer.cfc:283 and onMissingTemplate_include.cfm:143 drop from a filename.
const INDEX_FILE_SEGMENT = /^index\.[^/]*$/i;
// onMissingTemplate_include.cfm:131 splits cgi.path_info on each of these.
const MISSING_TEMPLATE_DELIMITERS = /[/,\\]/;
// The default customUrlVarDelimiters (configBean.cfc:173); parseCustomURLVars reads an item equal to one as `params`.
const CUSTOM_URL_VAR_DELIMITERS: readonly string[] = ['_'];
// Items parseCustomURLVars switches arrays on (contentServer.cfc:531), upper-cased as ListFindNoCase compares them.
const CUSTOM_URL_VAR_KEYWORDS: ReadonlySet<string> = new Set(['DATE', 'CATEGORY', 'PARAMS', 'TAG', 'LINKSERVID', 'SHOWMETA', 'REF']);
// Keywords whose array takes one item, after which items are dropped until the next keyword (contentServer.cfc:540-552).
const ONE_ITEM_KEYWORDS: ReadonlySet<string> = new Set(['TAG', 'LINKSERVID', 'SHOWMETA']);

/** `value` with every nested object frozen. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Values legacy's event can read for `name`: the url value it prefers, and the key's merged one. */
function valuesOf(facts: RequestFacts, name: string): string[] {
  return [facts.url, facts.params].flatMap((scope) => {
    const value = Object.hasOwn(scope, name) ? scope[name] : undefined;
    return value === undefined ? [] : [value];
  });
}

/** Whether `name` reads as a non-empty value, as `len(event(name))` tests it. */
function nonEmpty(facts: RequestFacts, name: string): boolean {
  return valuesOf(facts, name).some((value) => value.length > 0);
}

/** Whether `name` reads as one of `expected`, compared as CFML `==` and `switch` compare strings. */
function equalsAny(facts: RequestFacts, name: string, expected: readonly string[]): boolean {
  return valuesOf(facts, name).some((value) => expected.some((wanted) => cfEq(value, wanted)));
}

/** Whether cookie `name` is sent with a non-empty value. */
function cookieSet(facts: RequestFacts, name: string): boolean {
  return (facts.cookies.get(name) ?? '') !== '';
}

/** `segment` percent-decoded, or as sent when it does not decode. */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A candidate filename and the items extending it, so walking a run already named builds no string. */
interface FilenameNode {
  readonly name: string;
  readonly next: Map<string, FilenameNode>;
}

/** The keyword parseCustomURLVars reads `item` as, `PARAMS` for a custom URL var delimiter; undefined for any other item. */
function urlVarKeyword(item: string): string | undefined {
  const upper = item.toUpperCase();
  const keyword = CUSTOM_URL_VAR_DELIMITERS.some((delimiter) => delimiter.toUpperCase() === upper) ? 'PARAMS' : upper;
  return CUSTOM_URL_VAR_KEYWORDS.has(keyword) ? keyword : undefined;
}

/** The `currentFilenameAdjusted` items parseCustomURLVars sets for `items` from `start` on, given their `keywords`: its ref items if any, else its file items. */
function adjustedFilenameItems(items: readonly string[], keywords: readonly (string | undefined)[], start: number): readonly string[] {
  const appended: Record<'FILE' | 'REF', string[]> = { FILE: [], REF: [] };
  let current = 'FILE';
  for (const [offset, item] of items.slice(start).entries()) {
    const keyword = keywords[start + offset];
    if (keyword !== undefined) current = keyword;
    else if (ONE_ITEM_KEYWORDS.has(current)) current = '';
    // Params items are name/value pairs, and date and category items fill arrays the filename never reads.
    else if (current === 'FILE' || current === 'REF') appended[current].push(item);
  }
  return appended.REF.length > 0 ? appended.REF : appended.FILE;
}

/** Names `items` joined with `/` and each shorter prefix under `root`, appending each new name to `filenames`; false once past one probe's bounds. */
function namePrefixes(root: FilenameNode, filenames: string[], items: readonly string[]): boolean {
  let node = root;
  for (const item of items) {
    let next = node.next.get(item);
    if (next === undefined) {
      next = { name: node === root ? item : `${node.name}/${item}`, next: new Map() };
      if (next.name.length > ORPHAN_ARCHIVE_MAX_FILENAME_LENGTH) return false;
      node.next.set(item, next);
      filenames.push(next.name);
      if (filenames.length > ORPHAN_ARCHIVE_MAX_FILENAMES) return false;
    }
    node = next;
  }
  return true;
}

/** Filenames a 404 render may look up in `tcontentfilenamearchive`, render404's among them (contentServer.cfc:505-562; standardEventsHandler.cfc:469-497); undefined past one probe's bounds. */
export function orphanArchiveFilenames(facts: Pick<RequestFacts, 'path' | 'url'>): string[] | undefined {
  const sources = [facts.path, ...Object.entries(facts.url).flatMap(([name, value]) => (name.toLowerCase() === 'path' ? [value] : []))];
  // No item holds a `/`, so names and item lists correspond one to one.
  const root: FilenameNode = { name: '', next: new Map() };
  root.next.set(RENDER_404_FILENAME, { name: RENDER_404_FILENAME, next: new Map() });
  const filenames: string[] = [RENDER_404_FILENAME];
  const walked = new Set<string>();
  for (const sent of sources) {
    const texts = [sent, sent.split('/').map(decodedSegment).join('/')];
    for (const segments of texts.flatMap((text) => [text.split('/'), text.split(MISSING_TEMPLATE_DELIMITERS)])) {
      const kept = segments.filter((segment) => segment !== '');
      for (const variant of [kept, kept.filter((segment) => !INDEX_FILE_SEGMENT.test(segment))]) {
        const joined = variant.join('/');
        if (walked.has(joined)) continue;
        walked.add(joined);
        const keywords = variant.map(urlVarKeyword);
        // The current filename may start at any item, and each start names its runs of consecutive items. A start before the first
        // keyword item leaves either a run or the ref items a start at that keyword leaves, so only keyword starts are parsed.
        for (let start = 0; start < variant.length; start += 1) {
          if (!namePrefixes(root, filenames, variant.slice(start))) return undefined;
          if (keywords[start] !== undefined && !namePrefixes(root, filenames, adjustedFilenameItems(variant, keywords, start))) return undefined;
        }
      }
    }
  }
  return filenames;
}

/** Whether the remember-me login can run for the request apart from a static file legacy may serve without CFML. */
function rememberMeCandidate(family: RouteFamily, facts: RequestFacts): boolean {
  return !NO_STARTUP_FAMILIES.has(family) && cookieSet(facts, 'userid') && cookieSet(facts, 'userhash') && facts.sessionManaged();
}

/** Page routes of the doactions the display object an asynchronous request keyed `key` renders acts on (e.g. rater/index.cfm:93). */
export function asyncDoactionRoutes(key: Pick<RouteKeyResult, 'baseKey'>, facts: RequestFacts): string[] {
  if (!ASYNC_ROUTES.has(key.baseKey)) return [];
  const actions = valuesOf(facts, 'doaction').flatMap((value) => value.split(',').filter((action) => action !== ''));
  return [...new Set(actions.map((action) => `page:${action.toLowerCase()}`))];
}

/** Every guarded request-conditional write; any other write of an inventoried key is reached unconditionally. */
export const REQUEST_GUARDS: readonly RequestGuard[] = deepFreeze<RequestGuard[]>([
  {
    id: 'lockdown-login',
    vias: [['standardEventsHandler.standardEnableLockdownValidator']],
    // `locks eq "true"`; CFML truthiness is added so every spelling legacy might accept is covered.
    holds: (facts) => valuesOf(facts, 'locks').some((value) => cfEq(value, 'true') || (cfIsBoolean(value) && cfToBoolean(value))),
    source: 'core/mura/Handler/standardEventsHandler.cfc:682-701',
  },
  {
    id: MAGIC_LINK_GUARD,
    vias: [['standardEventsHandler.standardSetPermissionsHandler']],
    holds: (facts) => nonEmpty(facts, 'returnid') && nonEmpty(facts, 'returnuserid'),
    source: 'core/mura/Handler/standardEventsHandler.cfc:139-142; core/mura/user/userUtility.cfc:806-845',
  },
  {
    id: 'image-rendition',
    vias: [['standardEventsHandler.standardFileTranslator']],
    holds: (facts) => nonEmpty(facts, 'size'),
    source: 'core/mura/Handler/standardEventsHandler.cfc:807-818; core/mura/content/file/fileManager.cfc:243-247',
  },
  {
    id: 'orphan-archive-cleanup',
    vias: [['standardEventsHandler.standard404Handler']],
    holds: (facts) => facts.probes?.orphanArchive === true,
    pending: (facts) => (facts.probes?.orphanArchive === undefined ? 'orphanArchive' : undefined),
    source: 'core/mura/Handler/standardEventsHandler.cfc:459-499',
  },
  {
    // The inventory records a statement once per entry point, under the first branch reaching it (LastLogin under
    // loginByUserID, though remoteLogin reaches it too), so the login and edit-profile branches share one guard.
    id: 'async-account-write',
    vias: [
      ...['remoteLogin', 'handleChallengeAttempt', 'completedChallenge'].map((method) => [ASYNC_OBJECT, `loginManager.${method}`]),
      ...['update', 'createAddress', 'updateAddress', 'deleteAddress', 'sendLoginByUser'].map((method) => [ASYNC_OBJECT, `userManager.${method}`]),
      [ASYNC_OBJECT, 'userUtility.loginByUserID'],
    ],
    holds: (facts) =>
      (facts.method.toUpperCase() === 'POST' && equalsAny(facts, 'object', ['login'])) ||
      (equalsAny(facts, 'object', ['editprofile']) && equalsAny(facts, 'doaction', ['updateprofile', 'createprofile'])),
    source: 'core/mura/client/api/json/v1/jsonApiUtility.cfc:3893-3928, 3944-4026',
  },
]);

/** Every request writer no route key reaches; the inventory naming any other one fails {@link createRequestWrites}. */
export const STARTUP_WRITERS: readonly StartupWriter[] = deepFreeze<StartupWriter[]>([
  {
    id: 'wov:remember-me-login',
    // A static file runs the request start only when the container rewrites it to index.cfm or runs it as a template.
    holds: (family, facts) => rememberMeCandidate(family, facts) && (family !== 'static' || facts.probes?.cfml === true),
    pending: (family, facts) => (family === 'static' && facts.probes?.cfml === undefined && rememberMeCandidate(family, facts) ? 'cfml' : undefined),
    source: 'core/appcfc/onRequestStart_include.cfm:222-229; core/mura/login/loginManager.cfc:90-108; core/mura/user/userUtility.cfc:338',
  },
]);

const ALL_RENDER_GUARDS = ['lockdown-login', MAGIC_LINK_GUARD, 'image-rendition', 'orphan-archive-cleanup'];

/** The render guards each kind of legacy-bound request passes through beyond its own entry point. */
const PIPELINES: readonly Pipeline[] = deepFreeze<Pipeline[]>([
  {
    // CommandBox rewrites a missing static file to index.cfm, which renders it as a page.
    applies: (key) => key.family === 'page' || key.family === 'static',
    guards: ALL_RENDER_GUARDS,
    source: 'core/mura/content/contentServer.cfc:857-922; harness/repro/server.json.template (rewrites)',
  },
  {
    // A missing or invalid file, asset or feed renders the `404` page through the whole render pipeline.
    applies: (key) => key.family === 'render' || key.family === 'asset' || key.family === 'feed',
    guards: ALL_RENDER_GUARDS,
    source:
      'core/mura/content/contentServer.cfc:505-510; core/mura/content/file/fileManager.cfc:211-389; core/mura/client/api/feed/v1/feedApiUtility.cfc:258',
  },
  {
    applies: (key) => ASYNC_ROUTES.has(key.baseKey),
    guards: [MAGIC_LINK_GUARD],
    source: 'core/mura/client/api/json/v1/jsonApiUtility.cfc:3875',
  },
  {
    applies: (key) => key.family === 'feed',
    guards: [MAGIC_LINK_GUARD],
    source: 'core/mura/client/api/feed/v1/feedApiUtility.cfc:319-328',
  },
]);

/** Units written under one guard, or unconditionally when `guard` is undefined. */
interface GuardedUnits {
  readonly guard: RequestGuard | undefined;
  readonly units: readonly string[];
}

/** The guard a write is reached under: the one whose call-path prefix the write's `via` starts with. */
function guardOf(write: InventoryWrite): RequestGuard | undefined {
  return REQUEST_GUARDS.find((guard) => guard.vias.some((prefix) => prefix.every((step, i) => write.via[i] === step)));
}

/** The render guards the pipelines a request keyed `key` runs pass through. */
function pipelineGuards(key: Pick<RouteKeyResult, 'family' | 'baseKey'>): ReadonlySet<string> {
  return new Set(PIPELINES.filter((pipeline) => pipeline.applies(key)).flatMap((pipeline) => pipeline.guards));
}

/** Units of the guarded `groups` whose guard is one of `ids` and holds for `facts`. */
function holdingUnits(groups: readonly GuardedUnits[], ids: ReadonlySet<string>, facts: RequestFacts): string[] {
  const units = new Set<string>();
  for (const { guard, units: written } of groups) {
    if (guard !== undefined && ids.has(guard.id) && guard.holds(facts)) written.forEach((unit) => units.add(unit));
  }
  return [...units];
}

/** `pending` with `units` added under `kind`, each unit once. */
function addPending(pending: PendingProbes, kind: ProbeKind, units: readonly string[]): void {
  pending[kind] = [...new Set([...(pending[kind] ?? []), ...units])];
}

/** Per probe, the units of the guarded `groups` whose guard is one of `ids` and waits on that probe for `facts`. */
function pendingUnits(groups: readonly GuardedUnits[], ids: ReadonlySet<string>, facts: RequestFacts): PendingProbes {
  const pending: PendingProbes = {};
  for (const { guard, units } of groups) {
    const kind = guard !== undefined && ids.has(guard.id) ? guard.pending?.(facts) : undefined;
    if (kind !== undefined) addPending(pending, kind, units);
  }
  return pending;
}

/** Units of `table`'s ownership targets that own a column `writer` sets; every target when the inventory records no columns. */
function startupWriterUnits(ownership: OwnershipDoc, table: string, writer: InventoryWriter): string[] {
  const targets = ownership.tables.find((owned) => owned.table.toLowerCase() === table.toLowerCase())?.targets ?? [];
  const columns = writer.columns?.map((column) => column.toLowerCase());
  return targets
    .filter((target) => columns === undefined || target.ownedColumns.some((column) => columns.includes(column.toLowerCase())))
    .map((target) => target.unit);
}

/** Per normalised key with a guarded write, the units of its writes by guard, mapped by the version builder's write closure. */
function guardedGroupsOf(inventory: InventoryDoc, ownership: OwnershipDoc): Map<string, readonly GuardedUnits[]> {
  const closure = createWriteClosure(inventory, ownership);
  const items = [
    ...inventory.controllers.flatMap((controller) => controller.actions.flatMap((action) => action.variants)),
    ...inventory.routes,
    ...inventory.frontEnd,
  ];
  // Only keys with a guarded write change per request, so only their writes are grouped.
  const guardedKeys = new Set(
    items.flatMap((item) =>
      item.routeKey !== null && item.writeSet.some((write) => guardOf(write) !== undefined) ? [normaliseRouteKey(item.routeKey)] : [],
    ),
  );
  const writesByKey = new Map<string, Map<RequestGuard | undefined, InventoryWrite[]>>();
  for (const item of items) {
    if (item.routeKey === null || !guardedKeys.has(normaliseRouteKey(item.routeKey))) continue;
    const key = normaliseRouteKey(item.routeKey);
    const byGuard = writesByKey.get(key) ?? new Map<RequestGuard | undefined, InventoryWrite[]>();
    writesByKey.set(key, byGuard);
    for (const write of item.writeSet) {
      const guard = guardOf(write);
      const writes = byGuard.get(guard);
      if (writes === undefined) byGuard.set(guard, [write]);
      else writes.push(write);
    }
  }
  return new Map<string, readonly GuardedUnits[]>(
    [...writesByKey].map(([key, byGuard]) => [
      key,
      [...byGuard].map(([guard, writeSet]): GuardedUnits => ({ guard, units: closure({ id: key, writeSet }) })),
    ]),
  );
}

/** The inventory's start-up request writers with their units; throws for one {@link STARTUP_WRITERS} does not list. */
function startupWritersOf(inventory: InventoryDoc, ownership: OwnershipDoc): Array<{ writer: StartupWriter; units: string[] }> {
  return inventory.tables.flatMap((table) =>
    table.writers
      .filter((writer) => writer.trigger === 'request' && writer.routeKeys.length === 0)
      .map((writer) => {
        const known = STARTUP_WRITERS.find((entry) => entry.id === writer.override);
        if (known === undefined) {
          throw new Error(
            `${table.table}: request writer ${writer.component} ${writer.method} reaches no route key and is not a start-up writer of request-writes.ts`,
          );
        }
        return { writer: known, units: startupWriterUnits(ownership, table.table, writer) };
      }),
  );
}

/** Builds the request writes of `inventory`; the result keeps only the units derived from it, never the inventory. */
export function createRequestWrites(inventory: InventoryDoc, ownership: OwnershipDoc): RequestWrites {
  const groupsByKey = guardedGroupsOf(inventory, ownership);
  const renderGroups = groupsByKey.get(RENDER_ROUTE) ?? [];
  const startup = startupWritersOf(inventory, ownership);

  return {
    entryUnits(route, units, facts) {
      const groups = groupsByKey.get(normaliseRouteKey(route));
      if (groups === undefined) return units;
      const kept = new Set<string>();
      const dropped = new Set<string>();
      for (const { guard, units: written } of groups) {
        const into = guard === undefined || guard.holds(facts) ? kept : dropped;
        written.forEach((unit) => into.add(unit));
      }
      const effective = units.filter((unit) => kept.has(unit) || !dropped.has(unit));
      return effective.length === units.length ? units : effective;
    },

    pipelineUnits(key, facts) {
      const guards = pipelineGuards(key);
      return guards.size === 0 ? [] : holdingUnits(renderGroups, guards, facts);
    },

    startupUnits(family, facts) {
      return [...new Set(startup.flatMap(({ writer, units }) => (writer.holds(family, facts) ? units : [])))];
    },

    pipelineProbes(key, facts) {
      const guards = pipelineGuards(key);
      return guards.size === 0 ? {} : pendingUnits(renderGroups, guards, facts);
    },

    startupProbes(family, facts) {
      const pending: PendingProbes = {};
      for (const { writer, units } of startup) {
        const kind = writer.pending?.(family, facts);
        if (kind !== undefined) addPending(pending, kind, units);
      }
      return pending;
    },
  };
}
