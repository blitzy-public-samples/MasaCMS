// Closed, cited list of the request facts that decide which conditional legacy writes a legacy-bound request reaches.
import { cfEq, cfIsBoolean, cfToBoolean, normaliseRouteKey, type RouteFamily, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { createWriteClosure } from '../cutover/build-groups.js';
import type { InventoryDoc, InventoryWrite, InventoryWriter, OwnershipDoc } from '../cutover/types.js';

/** Request facts the guards read. */
export interface RequestFacts {
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
}

/** A request predicate without which legacy never reaches the writes whose call path starts with one of `vias`. */
export interface RequestGuard {
  readonly id: string;
  readonly vias: readonly (readonly string[])[];
  /** A superset of the legacy condition, so a request it rejects cannot reach the guarded writes. */
  readonly holds: (facts: RequestFacts) => boolean;
  readonly source: string;
}

/** A request writer the inventory reaches from no route key, because request start-up runs it before any entry point. */
export interface StartupWriter {
  /** The inventory writer's `override`. */
  readonly id: string;
  readonly holds: (family: RouteFamily, facts: RequestFacts) => boolean;
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
}

/** The front-end render route, whose handlers every page request runs (contentServer.cfc:857-922). */
export const RENDER_ROUTE = 'page:render';

const ASYNC_OBJECT = 'jsonApiUtility.processAsyncObject';
const ASYNC_ROUTES: ReadonlySet<string> = new Set(['api:processasyncobject', 'rest:processasyncobject']);
const MAGIC_LINK_GUARD = 'magic-link-login';
/**
 * Families start-up writes are not windowed for: target-served paths, the gateway-only bridge, and static paths, as windowing every asset request of a
 * remember-me browser would serialise its page loads; a missing file rewritten to index.cfm in a session not yet logged in is the residual case.
 */
const NO_STARTUP_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['static', 'opt2', 'bridge']);

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
    // Only stored rows decide this cleanup, and page renders are legacy-served without a window, so it never opens one;
    // a 404 meeting an orphan archive row is the residual case.
    holds: () => false,
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
    holds: (family, facts) =>
      !NO_STARTUP_FAMILIES.has(family) && cookieSet(facts, 'userid') && cookieSet(facts, 'userhash') && facts.sessionManaged(),
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

/** Units of the guarded `groups` whose guard is one of `ids` and holds for `facts`. */
function holdingUnits(groups: readonly GuardedUnits[], ids: ReadonlySet<string>, facts: RequestFacts): string[] {
  const units = new Set<string>();
  for (const { guard, units: written } of groups) {
    if (guard !== undefined && ids.has(guard.id) && guard.holds(facts)) written.forEach((unit) => units.add(unit));
  }
  return [...units];
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
      const guards = new Set(PIPELINES.filter((pipeline) => pipeline.applies(key)).flatMap((pipeline) => pipeline.guards));
      return guards.size === 0 ? [] : holdingUnits(renderGroups, guards, facts);
    },

    startupUnits(family, facts) {
      return [...new Set(startup.flatMap(({ writer, units }) => (writer.holds(family, facts) ? units : [])))];
    },
  };
}
