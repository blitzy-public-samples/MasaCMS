// The carch controller's before(): the Site Manager module gate and the rc and session defaults every cArch action reads.
import { isDeepStrictEqual } from 'node:util';
import { cfEq, cfToBoolean, cfUuid } from '@opt2/platform/legacy-compat';
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import { scanCompactDisplay } from '@/lib/cfml';
import {
  applyDefaults,
  servesRequestedSite,
  withSessionMuraValue,
  type AdminRequest,
  type AdminSessionWrites,
  type RequestContext,
} from '@/lib/request-context';
import type { ScreenOwner } from '../registry';
import { CARCH_SESSION_MODULE_IDS, CONTENT_MODULE_ID, SESSION_TOP_IDS } from './model';

/** Migrated service that owns every carch action. */
export const CARCH_OWNER = 'strategies-content' as const satisfies ScreenOwner;

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

// before() params session.openSectionList ahead of this check; the request set-up always defines it.
/** before() gate: a user without the Site Manager module of `rc.siteid` gets the controller's secure() decision. */
export const carchGate: ScreenGate = (req, { secure }) =>
  req.isS2 || (servesRequestedSite(req) && req.modulePerm(CONTENT_MODULE_ID)) ? ALLOW : secure();

/** `rc[name]` by case-insensitive name, for context views and plain records alike. */
function rcValue(rc: RequestContext, name: string): string | undefined {
  if (Object.hasOwn(rc, name)) return rc[name];
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/** `rc.ajaxrequest` as a CFML boolean, false when absent; throws TypeError for a value CFML cannot convert. */
export function isAjaxRequest(rc: RequestContext): boolean {
  return cfToBoolean(rcValue(rc, 'ajaxrequest') ?? 'false');
}

type Defaults = ReadonlyArray<readonly [name: string, value: string]>;

/** A mutable copy of a request context: case-insensitive names that keep their first-seen casing, in order. */
class RcDraft {
  readonly #entries = new Map<string, readonly [name: string, value: string]>();

  constructor(rc: RequestContext) {
    for (const [name, value] of Object.entries(rc)) this.set(name, value);
  }

  get(name: string): string | undefined {
    return this.#entries.get(name.toLowerCase())?.[1];
  }

  set(name: string, value: string): void {
    const key = name.toLowerCase();
    this.#entries.set(key, [this.#entries.get(key)?.[0] ?? name, value]);
  }

  /** CFML `param`: sets `value` only when `name` is absent; returns the value `name` then holds. */
  param(name: string, value: string): string {
    const current = this.get(name);
    if (current !== undefined) return current;
    this.set(name, value);
    return value;
  }

  paramAll(defaults: Defaults): void {
    for (const [name, value] of defaults) this.param(name, value);
  }

  /** The draft as a read-only case-insensitive context; its admin set-up defaults are already present. */
  toContext(): RequestContext {
    return applyDefaults(Object.fromEntries(this.#entries.values()));
  }
}

// rc.datasource is left out: it names the server's datasource, which no carried view reads.
/** Defaults of a non-ajax request in legacy order, with a new CF UUID as `contentHistID`. */
function pageDefaults(): Defaults {
  return [
    ['return', ''],
    ['startrow', '1'],
    ['contentid', ''],
    ['ptype', 'Page'],
    ['type', 'Page'],
    ['contentHistID', cfUuid()],
    ['parenthistid', ''],
    ['notify', ''],
    ['preview', '0'],
    ['size', '20'],
    ['action', ''],
    ['closeCompactDisplay', ''],
    ['compactDisplay', ''],
    ['returnURL', ''],
    ['homeID', ''],
    ['objectid', ''],
    ['locking', 'false'],
    ['moduleAssign', ''],
    ['orderno', '0'],
    ['cancelPendingApproval', 'false'],
    ['date1', ''],
    ['date2', ''],
    ['ommitPublishingTab', 'false'],
    ['ommitRelatedContentTab', 'false'],
    ['ommitAdvancedTab', 'false'],
    ['murakeepediting', 'false'],
    ['locknode', 'false'],
    ['frontend', 'false'],
  ];
}

const PUBLISHING_TAB_DEFAULTS: Defaults = [
  ['isNav', '0'],
  ['target', '_self'],
  ['searchExclude', '0'],
  ['restricted', '0'],
  ['mobileExclude', '0'],
];

const ADVANCED_TAB_DEFAULTS: Defaults = [
  ['isLocked', '0'],
  ['forceSSL', '0'],
  ['doCache', '1'],
  ['displayTitle', '0'],
];

const RELATED_CONTENT_TAB_DEFAULTS: Defaults = [['relatedContentSetData', '']];

const TRAILING_DEFAULTS: Defaults = [
  ['responseChart', '0'],
  ['parentid', ''],
];

const SESSION_MODULE_IDS: readonly string[] = CARCH_SESSION_MODULE_IDS;

/** CFML `listFind` over the session module ids: an exact, case-sensitive item match. */
const isSessionModuleId = (moduleId: string): boolean => SESSION_MODULE_IDS.includes(moduleId);

/** `session.moduleid` after before()'s whitelist sync; `rc.moduleid` is replaced where legacy replaces it. */
function syncModuleId(rc: RcDraft, sessionModuleId: string): string {
  // An unset session.moduleid reads as '', which the whitelist reset turns into the cfparam default.
  let moduleId = isSessionModuleId(sessionModuleId) ? sessionModuleId : CONTENT_MODULE_ID;
  const requested = rc.param('moduleid', CONTENT_MODULE_ID);
  if (requested !== '' && isSessionModuleId(requested)) moduleId = requested;
  if (requested === '' || !cfEq(moduleId, requested)) rc.set('moduleid', moduleId);
  return moduleId;
}

/** The session module tops with before()'s default added for each `m<moduleid>` key the session lacks. */
function moduleTopsWithDefaults(stored: Readonly<Record<string, string>>): Record<string, string> {
  const tops = { ...stored };
  for (const [key, topId] of Object.entries(SESSION_TOP_IDS)) if (!Object.hasOwn(tops, key)) tops[key] = topId;
  return tops;
}

/** `session['m<moduleId>'].topid`, failing as ACF does when the session holds none for the module. */
function sessionTopId(tops: Readonly<Record<string, string>>, moduleId: string): string {
  const key = `m${moduleId}`;
  const topId = tops[key];
  if (topId === undefined) {
    throw new TypeError(
      `Element ${key.toUpperCase()} is undefined in a Java object of type class coldfusion.runtime.MemorySessionScope.`,
    );
  }
  return topId;
}

/**
 * The request as carch before() leaves it: the scanned `compactDisplay`, rc defaults where a key is absent, the synced
 * module id and topid, and the changed `session.mura.objectInstanceId`, `session.moduleid` and module tops queued in
 * `sessionWrites`. Screens use the returned request in place of `req`.
 * @throws TypeError For an rc flag CFML cannot read as a boolean, or a module whose session topid is undefined.
 */
export function applyCarchDefaults(req: AdminRequest): AdminRequest {
  // The admin set-up's request scan and rc defaults precede the controller's.
  const rc = new RcDraft(applyDefaults(req.rc));
  rc.set('compactDisplay', scanCompactDisplay(rc.param('compactDisplay', 'false')));
  const ajaxRequest = rc.param('ajaxrequest', 'false');
  rc.param('moduleid', CONTENT_MODULE_ID);
  const instanceId = rc.param('instanceid', '');
  if (cfToBoolean(ajaxRequest)) return { ...req, rc: rc.toContext() };

  rc.paramAll(pageDefaults());
  if (!cfToBoolean(rc.param('ommitPublishingTab', 'false'))) rc.paramAll(PUBLISHING_TAB_DEFAULTS);
  if (!cfToBoolean(rc.param('ommitAdvancedTab', 'false'))) rc.paramAll(ADVANCED_TAB_DEFAULTS);
  if (!cfToBoolean(rc.param('ommitRelatedContentTab', 'false'))) rc.paramAll(RELATED_CONTENT_TAB_DEFAULTS);
  const user = instanceId === '' ? req.session : withSessionMuraValue(req.session, 'objectInstanceId', instanceId);
  rc.paramAll(TRAILING_DEFAULTS);

  // session.mura.viewDepth and nextN stay unset: the served shell site carries no ViewDepth or NextN.
  // session.keywords is always defined by the request set-up.
  const moduleId = syncModuleId(rc, req.session.moduleid);
  const tops = moduleTopsWithDefaults(req.session.moduleTopIds);
  const requestedTopId = rc.get('topid');
  const topId = requestedTopId === undefined || requestedTopId === '' ? sessionTopId(tops, moduleId) : requestedTopId;
  rc.set('topid', topId);
  tops[`m${moduleId}`] = topId;

  const writes: AdminSessionWrites = {
    ...(user.muraValues === req.session.muraValues ? {} : { muraValues: user.muraValues }),
    ...(moduleId === req.session.moduleid ? {} : { moduleid: moduleId }),
    ...(isDeepStrictEqual(tops, req.session.moduleTopIds) ? {} : { moduleTopIds: tops }),
  };
  if (Object.keys(writes).length === 0) return { ...req, rc: rc.toContext() };
  return {
    ...req,
    rc: rc.toContext(),
    session: { ...req.session, moduleid: moduleId, moduleTopIds: tops, mura: user.mura, muraValues: user.muraValues },
    sessionWrites: { ...req.sessionWrites, ...writes },
  };
}
