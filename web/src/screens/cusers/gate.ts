// The cUsers controller `before()`: the access gate and the request-context defaults every cUsers action reads (server-only).
import { cfEq, cfIsBoolean, cfListToArray, cfToBoolean } from '@opt2/platform/legacy-compat';
import type { GateDecision, ScreenGate } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';

/** Users module, which cUsers actions need on the site. */
const USERS_MODULE_ID = '00000000000000000000000000000000008';

/** Site Manager module, the site access paired with the Users module. */
const SITE_MODULE_ID = '00000000000000000000000000000000000';

/** The action whose subject's own user, or a user of a pool the caller administers, skips the module check. */
const LOAD_EXTENDED_ATTRIBUTES_ACTION = 'cUsers.loadExtendedAttributes';

const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });

/** A value of the normalised context: FW/1 text, or one `before()` computes. */
export type CusersRcValue = string | number | boolean | Readonly<Record<string, string>>;

/** The cUsers request context after `before()`; names resolve case-insensitively and keep the request's casing. */
export interface CusersRc {
  readonly [name: string]: CusersRcValue | undefined;
  readonly siteid: string;
  readonly isAdmin: boolean;
  /** Kept only for an S2 user who sent it. */
  readonly s2?: string;
  /** `{}` unless the request carried an `error` field. */
  readonly error: Readonly<Record<string, string>> | string;
  readonly startRow: number;
  readonly recordsperpage: number;
  readonly userid: string;
  readonly routeid: string;
  readonly categoryid: string;
  readonly type: string;
  readonly contactform: string;
  /** A CFML boolean; `1` unless an admin sent a boolean. */
  readonly ispublic: string;
  readonly email: string;
  readonly jobtitle: string;
  readonly lastupdate: string;
  readonly lastupdateby: string;
  readonly lastupdatebyid: string;
  readonly groupname: string;
  readonly fname: string;
  readonly lname: string;
  readonly address: string;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly phone1: string;
  readonly phone2: string;
  readonly fax: string;
  readonly perm: string;
  readonly groupid: string;
  readonly inactive: string;
  readonly returnurl: string;
  readonly search: string;
  readonly newsearch: string | boolean;
  /** A CFML boolean; `0` unless the request sent one. */
  readonly unassigned: string;
  /** `1` when `unassigned` is false, else `0`. */
  readonly unassignedlink: number;
}

/** The `param` defaults of `before()`, in its order and casing. */
const RC_DEFAULTS: ReadonlyArray<readonly [string, CusersRcValue]> = Object.freeze([
  ['error', Object.freeze({})],
  ['startrow', '1'],
  ['recordsperpage', '25'],
  ['userid', ''],
  ['routeid', ''],
  ['categoryid', ''],
  ['Type', '0'],
  ['ContactForm', '0'],
  ['isPublic', '1'],
  ['email', ''],
  ['jobtitle', ''],
  ['lastupdate', ''],
  ['lastupdateby', ''],
  ['lastupdatebyid', '0'],
  ['groupname', ''],
  ['fname', ''],
  ['lname', ''],
  ['address', ''],
  ['city', ''],
  ['state', ''],
  ['zip', ''],
  ['phone1', ''],
  ['phone2', ''],
  ['fax', ''],
  ['perm', '0'],
  ['groupid', ''],
  ['InActive', '0'],
  ['returnurl', ''],
  ['search', ''],
  ['newsearch', false],
  ['unassigned', '0'],
]);

/** Struct entries keyed by lower-cased name, each holding its first-seen name and its value. */
type RcEntries = Map<string, readonly [name: string, value: CusersRcValue]>;

function setEntry(entries: RcEntries, name: string, value: CusersRcValue): void {
  const key = name.toLowerCase();
  entries.set(key, [entries.get(key)?.[0] ?? name, value]);
}

const entryText = (entries: RcEntries, name: string): string => String(entries.get(name.toLowerCase())?.[1] ?? '');

/** A read-only view over `entries` whose property lookups ignore case, as a CFML struct reads. */
function rcView(entries: RcEntries): CusersRc {
  const valueOf = (name: string | symbol): CusersRcValue | undefined =>
    typeof name === 'string' ? entries.get(name.toLowerCase())?.[1] : undefined;
  const target = Object.create(null) as Record<string, CusersRcValue>;
  return new Proxy(target, {
    get: (_target, name) => valueOf(name),
    has: (_target, name) => valueOf(name) !== undefined,
    ownKeys: () => [...entries.values()].map(([name]) => name),
    getOwnPropertyDescriptor: (_target, name) => {
      const value = valueOf(name);
      return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  }) as unknown as CusersRc;
}

/** CFML `Val`: the leading numeric prefix of `text`, else 0. */
function cfmlVal(text: string): number {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : 0;
}

/** `rc[name]` by case-insensitive name, for a context view or a plain record alike. */
function rcValue(rc: AdminRequest['rc'], name: string): string | undefined {
  if (Object.hasOwn(rc, name)) return rc[name];
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/** `rc.isAdmin`: membership `Admin;<privateUserPoolID>;0` of the request's site, or `S2`. */
export function isCusersAdmin(req: Pick<AdminRequest, 'isS2' | 'isSiteAdmin'>): boolean {
  return req.isSiteAdmin || req.isS2;
}

/** The context `before()` leaves: site fallback, `isAdmin`, `s2` kept for S2 only, defaults and scrubbed paging. */
export function normaliseCusersRc(req: Pick<AdminRequest, 'rc' | 'session' | 'isS2' | 'isSiteAdmin'>): CusersRc {
  const rc: RcEntries = new Map();
  for (const [name, value] of Object.entries(req.rc)) setEntry(rc, name, value);
  if (entryText(rc, 'siteid') === '') setEntry(rc, 'siteid', req.session.siteid !== '' ? req.session.siteid : 'default');
  const isAdmin = isCusersAdmin(req);
  setEntry(rc, 'isAdmin', isAdmin);
  if (!req.isS2) rc.delete('s2');
  for (const [name, value] of RC_DEFAULTS) if (!rc.has(name.toLowerCase())) setEntry(rc, name, value);

  if (!cfIsBoolean(entryText(rc, 'ispublic')) || !isAdmin) setEntry(rc, 'ispublic', '1');
  if (!cfIsBoolean(entryText(rc, 'unassigned'))) setEntry(rc, 'unassigned', '0');
  setEntry(rc, 'unassignedlink', cfToBoolean(entryText(rc, 'unassigned')) ? 0 : 1);
  const startRow = cfmlVal(entryText(rc, 'startRow'));
  setEntry(rc, 'startRow', startRow < 1 ? 1 : startRow);
  const recordsPerPage = cfmlVal(entryText(rc, 'recordsperpage'));
  setEntry(rc, 'recordsperpage', recordsPerPage < 1 ? 25 : recordsPerPage);
  return rcView(rc);
}

/**
 * The user pool a cUsers form edits: the site's private pool for an admin on system users, else its public pool.
 * @throws TypeError When the request carries no data for its site.
 */
export function userPoolIdFor(req: Pick<AdminRequest, 'site'>, rc: Pick<CusersRc, 'ispublic' | 'isAdmin'>): string {
  if (req.site === undefined) throw new TypeError('userPoolIdFor: the request carries no site data');
  return rc.isAdmin && !cfToBoolean(rc.ispublic) ? req.site.privateUserPoolID : req.site.publicUserPoolID;
}

/** cUsers `before()` gate: Users and Site Manager module access, or admin; else the controller's `secure()`. */
export const cusersGate: ScreenGate = async (req, { secure }) => {
  const baseId = rcValue(req.rc, 'baseID');
  const extendedAttributesOfReachableUser =
    baseId !== undefined &&
    cfEq(cfListToArray(req.action, ':').at(-1) ?? '', LOAD_EXTENDED_ATTRIBUTES_ACTION) &&
    (cfEq(baseId, req.session.mura.userID) || (await req.reversePermLookUp()));
  if (extendedAttributesOfReachableUser) return ALLOW;
  if (isCusersAdmin(req) || (req.modulePerm(USERS_MODULE_ID) && req.modulePerm(SITE_MODULE_ID))) return ALLOW;
  return secure();
};
