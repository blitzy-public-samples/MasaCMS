// Shared view-model types and pure derivations of the carch screens: module ids, type lists, lock and delete state.
import { cfListToArray } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/strategies-content';
import { cfEq } from '@/lib/cfml';
import type { AdminRequest, AdminSessionState } from '@/lib/request-context';

/** Site Manager module. */
export const CONTENT_MODULE_ID = '00000000000000000000000000000000000';
/** Components module. */
export const COMPONENT_MODULE_ID = '00000000000000000000000000000000003';
/** Forms module. */
export const FORM_MODULE_ID = '00000000000000000000000000000000004';
/** Variations module. */
export const VARIATION_MODULE_ID = '00000000000000000000000000000000099';
/** The site's home node. */
export const ROOT_CONTENT_ID = '00000000000000000000000000000000001';

/** Module ids `before()` keeps in `session.moduleid`, in legacy list order. */
export const CARCH_SESSION_MODULE_IDS = Object.freeze([
  CONTENT_MODULE_ID,
  // Legacy's 36-character typo, kept so the whitelist accepts exactly what its listFind accepts.
  '000000000000000000000000000000000099',
  COMPONENT_MODULE_ID,
  FORM_MODULE_ID,
  VARIATION_MODULE_ID,
] as const);

/** Default `topid` per session key `m<moduleid>`. */
export const SESSION_TOP_IDS: Readonly<Record<string, string>> = Object.freeze({
  [`m${CONTENT_MODULE_ID}`]: ROOT_CONTENT_ID,
  [`m${COMPONENT_MODULE_ID}`]: COMPONENT_MODULE_ID,
  [`m${FORM_MODULE_ID}`]: FORM_MODULE_ID,
  [`m${VARIATION_MODULE_ID}`]: VARIATION_MODULE_ID,
});

/** Content types that are site tree nodes (`nodeLevelList`). */
export const NODE_LEVEL_LIST = Object.freeze(['Page', 'Folder', 'Calendar', 'Gallery', 'Link', 'File'] as const);

const PAGE_LEVEL_LIST = Object.freeze(['Page', 'Folder', 'Calendar']);
const GALLERY_PAGE_LEVEL_LIST = Object.freeze(['Page', 'Folder', 'Calendar', 'Gallery']);
const EXTENDED_LIST = Object.freeze(['Page', 'Folder', 'Calendar', 'Link', 'File', 'Component', 'Form']);
const GALLERY_EXTENDED_LIST = Object.freeze(['Page', 'Folder', 'Calendar', 'Gallery', 'Link', 'File', 'Component', 'Form']);

/** Types the edit screen offers beside `type` (`pageLevelList`). */
export function pageLevelList(type: string): readonly string[] {
  return cfEq(type, 'Gallery') ? GALLERY_PAGE_LEVEL_LIST : PAGE_LEVEL_LIST;
}

/** Types whose class extensions the edit screen lists for `type` (`extendedList`). */
export function extendedList(type: string): readonly string[] {
  return cfEq(type, 'Gallery') ? GALLERY_EXTENDED_LIST : EXTENDED_LIST;
}

type Schemas = components['schemas'];

/** Screen model a strategies-content carch page operation returns. */
export type CarchPageData = Schemas['AdminViewModel'];
/** Legacy `rc` values of a carch screen model, under their legacy names. */
export type CarchRc = CarchPageData['rc'];
/** A struct under `rc` (a bean's `getAllValues()` or a query row) whose fields the contract leaves open; keys match case-insensitively, as in CFML. */
export type CarchStruct = Readonly<CarchRc>;
/** A content bean or content version (`rc.contentBean`, `rc.item`). */
export type CarchContentView = CarchStruct;
/** A content stats bean (`contentBean.getStats()`). */
export type CarchStats = CarchStruct;
/** One `contentManager.getCrumbList` entry. */
export type CarchCrumb = CarchStruct;

const NODE_PERMS = Object.freeze(['editor', 'author', 'read', 'none', 'deny', 'module'] as const);
/** Node verdicts strategies-content reports as `rc.perm`. */
export type NodePerm = (typeof NODE_PERMS)[number];

/** A struct value by case-insensitive key; undefined when absent. */
export function structValue(struct: CarchStruct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple struct value as CFML text; absent and SQL NULL read as `''`, complex values throw. */
export function structText(struct: CarchStruct, key: string): string {
  const value = structValue(struct, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${key} is not a simple value`);
}

/** A nested struct by case-insensitive key; throws when it is absent or not a struct. */
export function structOf(struct: CarchStruct, key: string): CarchStruct {
  const value = structValue(struct, key);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${key} is not a struct`);
  return value as CarchStruct;
}

/** `rc.perm` of a carch screen model, lower-cased as legacy spells verdicts; throws when it is not a verdict. */
export function permOf(view: CarchPageData): NodePerm {
  const perm = structText(view.rc, 'perm').toLowerCase();
  const verdict = NODE_PERMS.find((candidate) => candidate === perm);
  if (verdict === undefined) throw new TypeError(`rc.perm is not a node verdict: '${perm}'`);
  return verdict;
}

/** Node lock flags of the secondary menu, history, audit and status views. */
export interface LockState {
  readonly isLocked: boolean;
  readonly isLockedBySomeoneElse: boolean;
  readonly nodeLockedByYou: boolean;
  readonly nodeLockedBySomeoneElse: boolean;
}

/** Lock flags of a node's stats for the session user `userId`. */
export function lockState(stats: CarchStats, site: { readonly hasLockableNodes: boolean }, userId: string): LockState {
  const lockId = structText(stats, 'lockID');
  const nodeLock = cfEq(structText(stats, 'lockType'), 'node');
  const isLocked = site.hasLockableNodes && lockId.length > 0 && nodeLock;
  const lockedBySomeoneElse = isLocked && !cfEq(lockId, userId);
  return {
    isLocked,
    isLockedBySomeoneElse: lockedBySomeoneElse,
    // The status view tests no lock id length here, so an empty id matches an empty user id.
    nodeLockedByYou: site.hasLockableNodes && nodeLock && cfEq(lockId, userId),
    nodeLockedBySomeoneElse: lockedBySomeoneElse,
  };
}

/** Inputs of {@link isDeletable}. */
export interface DeletableInput {
  /** `rc.compactDisplay`; omitted for history and audit, whose test leaves it out. */
  readonly compactDisplay?: string;
  readonly parentId: string;
  readonly contentId: string;
  /** Site setting `locking`. */
  readonly siteLocking: string;
  readonly perm: NodePerm;
  /** The content bean's `isLocked` value, not its node lock. */
  readonly isLocked: number | string;
}

/** `rc.deletable`: whether the node may be deleted with its children. */
export function isDeletable(input: DeletableInput): boolean {
  const { compactDisplay, parentId, contentId, siteLocking, perm, isLocked } = input;
  const underRoot = cfEq(parentId, ROOT_CONTENT_ID);
  return (
    (compactDisplay === undefined || !cfEq(compactDisplay, 'true')) &&
    ((!underRoot && !cfEq(siteLocking, 'all')) || (underRoot && cfEq(siteLocking, 'none'))) &&
    cfEq(perm, 'editor') &&
    !cfEq(contentId, ROOT_CONTENT_ID) &&
    !cfEq(isLocked, 1)
  );
}

type SessionUser = AdminSessionState['mura'];

/** The verified session data the membership checks read; an `AdminRequest` satisfies it. */
export type CarchSessionFlags = Pick<AdminRequest, 'isS2' | 'isSiteAdmin'> & {
  readonly session: Pick<AdminSessionState, 's2IsPrivate'> & {
    readonly mura: Pick<SessionUser, 'userID' | 'memberships'>;
  };
};

/** Membership `Admin;<privateUserPoolID>;0` of the request's site, or `S2`. */
export function isSiteAdminOrS2(req: Pick<AdminRequest, 'isS2' | 'isSiteAdmin'>): boolean {
  return req.isSiteAdmin || req.isS2;
}

/** Membership `S2IsPrivate`, or with `siteId` the case-insensitive `S2IsPrivate;<siteId>`. */
export function isS2IsPrivate(req: Pick<CarchSessionFlags, 'session'>, siteId?: string): boolean {
  if (siteId === undefined) return req.session.s2IsPrivate;
  const entry = `S2IsPrivate;${siteId}`.toLowerCase();
  return cfListToArray(req.session.mura.memberships ?? '').some((item) => item.toLowerCase() === entry);
}

/** The derived state a carch view computes once per request. */
export interface CarchViewState extends LockState {
  readonly perm: NodePerm;
  readonly deletable: boolean;
  readonly siteAdminOrS2: boolean;
  readonly s2IsPrivate: boolean;
}

/** Inputs of {@link carchViewState}. */
export interface CarchViewStateInput extends DeletableInput {
  readonly stats: CarchStats;
  readonly hasLockableNodes: boolean;
}

/** Lock, delete and membership state of a carch view for the request's session user. */
export function carchViewState(req: CarchSessionFlags, input: CarchViewStateInput): CarchViewState {
  return {
    ...lockState(input.stats, input, req.session.mura.userID),
    perm: input.perm,
    deletable: isDeletable(input),
    siteAdminOrS2: isSiteAdminOrS2(req),
    s2IsPrivate: isS2IsPrivate(req),
  };
}
