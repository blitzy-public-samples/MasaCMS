/** Content reads, version history, Site Manager tree data, node and file locks, and the session effects of carch's Site Manager actions. */
import { cfEq } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import {
  HISTORY_MAX_PAGE,
  ROOT_PARENT_ID,
  type ApprovalListRow,
  type ChangesetPreview,
  type ContentVersionRow,
  type Crumb,
  type DraftHistRow,
  type DraftListPaging,
  type DraftListRow,
  type HistRow,
  type ItemCountRow,
  type KidsArgs,
  type KidsRow,
  type NestRow,
  type PendingByContentRow,
  type PendingChangesetRow,
  type StatsRow,
} from '../repo/content-queries.js';
import type { ContentRepository } from '../repo/repository.js';
import type { ChangesetRow, FileRow } from '../repo/tables.js';
import { writeContextFor, type Actor, type DomainDeps } from './context.js';
import { getNodePerm, loadMemberships, sitePools, type NodeVerdict, type UserMemberships } from './permissions.js';
import { withPoolTenant } from './pools.js';

/** Content id of a site's home page, which an empty filename reads. */
const HOME_CONTENT_ID = '00000000000000000000000000000000001';
const PAGE_NOT_FOUND = 'The requested page could not be found.';
const VERSION_NOT_FOUND = 'The requested version of this content could not be found.';

/** A `getNodePerm` verdict. */
export type NodePerm = Exclude<NodeVerdict, 'deny'>;

/** The values contentDAO sets on the bean when no version matched and `use404` is off: an active bean of the site. */
export interface NewContentValues {
  active: 1;
  siteid: string;
}

/** contentDAO's 404 bean, set when no version matched and `use404` is on (contentDAO.cfc:163-178). */
export interface NotFoundContentValues extends NewContentValues {
  type: 'Page';
  subtype: 'Default';
  body: string;
  title: '404';
  menutitle: '404';
  filename: '404';
  parentid: string;
  contentid: string;
  path: string;
  display: 1;
  approved: 1;
}

/** A content bean as `contentManager.read` leaves it: the stored version (`isNew` 0) or legacy's new bean (`isNew` 1). */
export type ContentBean =
  | { isNew: 0; version: ContentVersionRow }
  | { isNew: 1; version: null; values: NewContentValues | NotFoundContentValues };

/** The arguments of `contentManager.read`; the first non-empty key in legacy's order selects the read. */
export interface ContentRef {
  siteId: string;
  contentId?: string;
  contentHistId?: string;
  /** Selects the filename read whenever given, even empty, as legacy tests `structKeyExists(arguments, "filename")`. */
  filename?: string;
  remoteId?: string;
  title?: string;
  urlTitle?: string;
  /** Narrows the filename, remote id, title and URL title reads to one content type. */
  type?: string;
  use404?: boolean;
  /** The session's change-set preview, supplied only for that preview's site. */
  preview?: ChangesetPreview | null;
}

/** A content item of a site. */
export interface ItemRef {
  contentId: string;
  siteId: string;
}

// The `tfiles` columns the version and tree reads left-join on `fileid` alone.
const FILE_COLUMNS = ['filesize', 'fileext', 'contenttype', 'contentsubtype', 'assocfilename'] as const;

/** A row carrying the `tfiles` columns of its `fileid`. */
type FileJoined = { fileid: string | null; filesize: FileRow['filesize'] | null; fileext: string | null };

/** `rows` with the file columns filled in the file-pool tenant where the site's files live in another tenant. */
async function withPooledFiles<R extends FileJoined>(deps: DomainDeps, actor: Actor, rows: R[]): Promise<R[]> {
  const unjoined = (row: R): boolean => row.fileid !== null && row.fileid !== '' && row.filesize === null && row.fileext === null;
  const fileIds = [...new Set(rows.filter(unjoined).map((row) => row.fileid as string))];
  if (fileIds.length === 0) {
    return rows;
  }
  // Legacy joins `tfiles` on fileid alone, so a pooled file's columns are read where the pool keeps the file.
  const files = await withPoolTenant(deps.db, actor.tenantId, 'file', (tx, poolTenantId) =>
    poolTenantId === actor.tenantId ? Promise.resolve([]) : deps.repository.content.fileJoinColumns(tx, fileIds),
  );
  const byId = new Map(files.map((file) => [file.fileid.toLowerCase(), file]));
  return rows.map((row) => {
    const file = unjoined(row) ? byId.get((row.fileid as string).toLowerCase()) : undefined;
    if (file === undefined) {
      return row;
    }
    const filled: Record<string, unknown> = { ...row };
    for (const column of FILE_COLUMNS) {
      if (column in row) {
        filled[column] = file[column];
      }
    }
    return filled as R;
  });
}

/** `bean` with its version's pooled file columns filled. */
async function withPooledFile(deps: DomainDeps, actor: Actor, bean: ContentBean): Promise<ContentBean> {
  if (bean.isNew === 1) {
    return bean;
  }
  const [version] = await withPooledFiles(deps, actor, [bean.version]);
  return { isNew: 0, version: version ?? bean.version };
}

/** contentDAO's bean for the rows of a read: the chosen row, else the 404 or new bean of `siteId`. */
function beanOf(version: ContentVersionRow | undefined, siteId: string, use404: boolean, notFoundBody: string): ContentBean {
  if (version !== undefined) {
    return { isNew: 0, version };
  }
  if (!use404) {
    return { isNew: 1, version: null, values: { active: 1, siteid: siteId } };
  }
  return {
    isNew: 1,
    version: null,
    values: {
      active: 1,
      siteid: siteId,
      type: 'Page',
      subtype: 'Default',
      body: notFoundBody,
      title: '404',
      menutitle: '404',
      filename: '404',
      parentid: ROOT_PARENT_ID,
      contentid: HOME_CONTENT_ID,
      path: HOME_CONTENT_ID,
      display: 1,
      approved: 1,
    },
  };
}

/** The content id and site the bean's `getStats()`, `getHist` and crumb reads use: the stored version's, or the new bean's. */
function beanItem(bean: ContentBean): ItemRef {
  if (bean.isNew === 0) {
    return { contentId: bean.version.contentid ?? '', siteId: bean.version.siteid ?? '' };
  }
  return { contentId: 'contentid' in bean.values ? bean.values.contentid : '', siteId: bean.values.siteid };
}

/** getContentVersion: the version `contentHistId` in any site of the tenant, as contentDAO.readVersion reads it. */
async function versionBean(tx: TenantTx, repo: ContentRepository, args: { contentHistId: string; siteId: string; use404?: boolean }): Promise<ContentBean> {
  const [version] = await repo.content.readVersion(tx, { contentHistId: args.contentHistId });
  return beanOf(version, args.siteId, args.use404 === true, VERSION_NOT_FOUND);
}

/** getActiveContent: the first active version of `contentId` in `siteId`. */
async function activeBean(
  tx: TenantTx,
  repo: ContentRepository,
  args: ItemRef & { use404?: boolean; preview?: ChangesetPreview | null },
): Promise<ContentBean> {
  const [version] = await repo.content.readActive(tx, { contentId: args.contentId, siteId: args.siteId, preview: args.preview ?? null });
  return beanOf(version, args.siteId, args.use404 === true, PAGE_NOT_FOUND);
}

/** The bean of a by-key active read; with several matches contentDAO's row loop leaves the last row's bean. */
function lastRowBean(rows: readonly ContentVersionRow[], ref: ContentRef): ContentBean {
  return beanOf(rows.at(-1), ref.siteId, ref.use404 === true, PAGE_NOT_FOUND);
}

/** getActiveContentByFilename's slash trim: `/` is the home page, and one leading and one trailing slash are dropped. */
function trimFilename(filename: string): string {
  if (filename === '/') {
    return '';
  }
  const withoutLead = filename.startsWith('/') ? filename.slice(1) : filename;
  return withoutLead.endsWith('/') ? withoutLead.slice(0, -1) : withoutLead;
}

/** contentManager.read's dispatch [contentManager.cfc:359-390] inside `tx`. */
async function readBean(tx: TenantTx, repo: ContentRepository, ref: ContentRef): Promise<ContentBean> {
  const { siteId } = ref;
  const type = ref.type ?? '';
  const preview = ref.preview ?? null;
  if ((ref.contentHistId ?? '') !== '') {
    return versionBean(tx, repo, { contentHistId: ref.contentHistId ?? '', siteId, use404: ref.use404 });
  }
  if (ref.filename !== undefined) {
    const filename = trimFilename(ref.filename);
    if (filename === '') {
      return activeBean(tx, repo, { contentId: HOME_CONTENT_ID, siteId, use404: ref.use404, preview });
    }
    return lastRowBean(await repo.content.readActiveByFilename(tx, { siteId, preview, type, filename }), ref);
  }
  if ((ref.remoteId ?? '') !== '') {
    return lastRowBean(await repo.content.readActiveByRemoteId(tx, { siteId, preview, type, remoteId: ref.remoteId ?? '' }), ref);
  }
  if ((ref.title ?? '') !== '') {
    return lastRowBean(await repo.content.readActiveByTitle(tx, { siteId, preview, type, title: ref.title ?? '' }), ref);
  }
  if ((ref.urlTitle ?? '') !== '') {
    return lastRowBean(await repo.content.readActiveByUrlTitle(tx, { siteId, preview, type, urlTitle: ref.urlTitle ?? '' }), ref);
  }
  return activeBean(tx, repo, { contentId: ref.contentId ?? '', siteId, use404: ref.use404, preview });
}

// ---- content reads ----

/** contentManager.read [contentManager.cfc:359-390]: the version or active content `ref` names, else the new or (`use404`) 404 bean. */
export async function readContent(deps: DomainDeps, actor: Actor, ref: ContentRef): Promise<ContentBean> {
  if (ref.siteId === '') {
    throw new Error("A 'SITEID' is required in order to read content. ");
  }
  const bean = await withTenant(deps.db, actor.tenantId, (tx) => readBean(tx, deps.repository, ref));
  return withPooledFile(deps, actor, bean);
}

/** contentManager.getActiveContent [contentManager.cfc:738-804]: the active version of an item. */
export async function getActiveContent(
  deps: DomainDeps,
  actor: Actor,
  args: ItemRef & { use404?: boolean; preview?: ChangesetPreview | null },
): Promise<ContentBean> {
  const bean = await withTenant(deps.db, actor.tenantId, (tx) => activeBean(tx, deps.repository, args));
  return withPooledFile(deps, actor, bean);
}

/** contentManager.getContentVersion [contentManager.cfc:392-437]: one version by contenthistid. */
export async function getContentVersion(
  deps: DomainDeps,
  actor: Actor,
  args: { contentHistId: string; siteId: string; use404?: boolean },
): Promise<ContentBean> {
  const bean = await withTenant(deps.db, actor.tenantId, (tx) => versionBean(tx, deps.repository, args));
  return withPooledFile(deps, actor, bean);
}

/** Arguments of `getCrumbList`; `path` is the item's stored path, which reads the crumbs at once. */
export interface CrumbListArgs extends ItemRef {
  path?: string;
  /** `desc` returns the crumbs root first. */
  sort?: string;
}

/** contentManager.getCrumbList [contentManager.cfc:825-841]: the item's crumbs, node to root unless `sort` is `desc`. */
export async function getCrumbList(deps: DomainDeps, actor: Actor, args: CrumbListArgs): Promise<Crumb[]> {
  const crumbs = await withTenant(deps.db, actor.tenantId, (tx) =>
    deps.repository.content.crumbPath(tx, { contentId: args.contentId, siteId: args.siteId, path: args.path }),
  );
  return cfEq(args.sort ?? 'asc', 'desc') ? crumbs.reverse() : crumbs;
}

/** getCrumbList's `setInheritance` effect: `request.inheritedObjects`, the version of the first crumb cascading its objects, else ''. */
export function inheritedObjectsOf(crumbs: readonly Crumb[]): string {
  return crumbs.find((crumb) => cfEq(crumb.inheritobjects ?? '', 'cascade'))?.contenthistid ?? '';
}

// ---- version history ----

/** The rc data carch.hist and carch.audit and their views read before listing versions. */
export interface VersionScreenModel {
  /** `rc.contentBean`: the item's active version. */
  contentBean: ContentBean;
  /** `rc.rsCount`: contentManager.getItemCount. */
  rsCount: ItemCountRow[];
  /** The view's `getCrumbList(rc.contentid, rc.siteid)`. */
  crumbs: Crumb[];
  /** The view's `getNodePerm(crumbdata)`. */
  perm: NodePerm;
  /** `rc.contentBean.getStats()`; null where the item has no stats row. */
  stats: StatsRow | null;
}

/** carch.hist [carch.cfc:456-461] and hist.cfm: the screen data and the version history iterator's first page. */
export interface HistoryModel extends VersionScreenModel {
  /** `contentBean.getVersionHistoryIterator()`: getHist rows, at most one iterator page of 1000. */
  items: HistRow[];
  /** The getHist row count. */
  historyTotal: number;
  /** Each item's `getParentID()`, which the nav bean reads from the version, keyed by its contenthistid. */
  parents: Map<string, string | null>;
}

/** carch.audit [carch.cfc:464-469] and audit.cfm: the screen data and the versions the audit trail lists. */
export interface AuditModel extends VersionScreenModel {
  /** The version `contenthistid`, then each `getSource()` while one is found. */
  trail: ContentVersionRow[];
  /** audit.cfm's `changesetBean.loadBy(changesetID)` of each trail version in a change set, keyed by that id; unknown ids are absent. */
  changesets: Map<string, ChangesetRow>;
}

/** The screen reads shared by the history and audit screens, in one tenant transaction. */
async function screenReads(tx: TenantTx, repo: ContentRepository, item: ItemRef): Promise<Omit<VersionScreenModel, 'perm'>> {
  const contentBean = await activeBean(tx, repo, item);
  return {
    contentBean,
    rsCount: await repo.content.itemCount(tx, item),
    crumbs: await repo.content.crumbPath(tx, item),
    stats: await repo.stats.readStats(tx, beanItem(contentBean)),
  };
}

/** The screen model with its node verdict and the active version's pooled file columns. */
async function finishScreen<M extends Omit<VersionScreenModel, 'perm'>>(deps: DomainDeps, actor: Actor, model: M): Promise<M & { perm: NodePerm }> {
  return { ...model, contentBean: await withPooledFile(deps, actor, model.contentBean), perm: await getNodePerm(deps, actor, model.crumbs) };
}

/** contentBean.getSource [contentBean.cfc:1431-1441]: the active version whose contentid is a source map's `sourceid`, following older maps. */
async function sourceOf(tx: TenantTx, repo: ContentRepository, version: ContentVersionRow): Promise<ContentVersionRow | undefined> {
  // The ORM `source` relation loads by the content primary key (contentid) although `sourceid` holds a contenthistid,
  // so legacy finds no source for an ordinary version and walks the maps to their end.
  let map = await repo.content.sourceMap(tx, { contentHistId: version.contenthistid ?? '', siteId: version.siteid ?? '' });
  const visited = new Set<string>();
  while (map !== null && !visited.has(map.mapid)) {
    visited.add(map.mapid);
    const [source] = await repo.content.readActive(tx, { contentId: map.sourceid ?? '', siteId: map.siteid ?? '' });
    if (source !== undefined) {
      return source;
    }
    map = await repo.content.sourceMap(tx, { contentHistId: map.sourceid ?? '', siteId: map.siteid ?? '' });
  }
  return undefined;
}

/** The audit trail of `contentHistId`: the version, then each source while `getIsNew()` is false. */
async function versionTrail(tx: TenantTx, repo: ContentRepository, contentHistId: string): Promise<ContentVersionRow[]> {
  const trail: ContentVersionRow[] = [];
  const seen = new Set<string>();
  let [item] = await repo.content.readVersion(tx, { contentHistId });
  while (item !== undefined && !seen.has(item.contenthistid ?? '')) {
    seen.add(item.contenthistid ?? '');
    trail.push(item);
    item = await sourceOf(tx, repo, item);
  }
  return trail;
}

/** contentManager.getHist with getItemCount, as the carch.hist screen reads them. */
export async function getHistory(deps: DomainDeps, actor: Actor, item: ItemRef): Promise<HistoryModel> {
  const model = await withTenant(deps.db, actor.tenantId, async (tx) => {
    const screen = await screenReads(tx, deps.repository, item);
    const page = await deps.repository.content.historyPage(tx, 'hist', beanItem(screen.contentBean), { limit: HISTORY_MAX_PAGE });
    const parents = await deps.repository.content.versionParents(tx, { contentHistIds: page.rows.map((row) => row.contenthistid ?? '') });
    return { ...screen, items: page.rows, historyTotal: page.total, parents };
  });
  return finishScreen(deps, actor, model);
}

/** The change sets of the trail versions that name one, keyed by the version's `changesetid`. */
async function trailChangesets(tx: TenantTx, repo: ContentRepository, trail: readonly ContentVersionRow[]): Promise<Map<string, ChangesetRow>> {
  const found = new Map<string, ChangesetRow>();
  for (const changesetId of new Set(trail.map((version) => version.changesetid ?? '').filter((id) => id !== ''))) {
    const row = await repo.changesets.findChangeset(tx, { changesetId });
    if (row !== null) {
      found.set(changesetId, row);
    }
  }
  return found;
}

/** The carch.audit screen: the item's screen data, the audit trail of `contentHistId` and the trail's change sets. */
export async function getAudit(deps: DomainDeps, actor: Actor, args: ItemRef & { contentHistId: string }): Promise<AuditModel> {
  const model = await withTenant(deps.db, actor.tenantId, async (tx) => {
    const screen = await screenReads(tx, deps.repository, args);
    const trail = await versionTrail(tx, deps.repository, args.contentHistId);
    return { ...screen, trail, changesets: await trailChangesets(tx, deps.repository, trail) };
  });
  return finishScreen(deps, actor, model);
}

/** carch.getAuditTrail [carch.cfc:630-643]: the contenthistids of the audit trail, which the route encodes with muraJsonEncode. */
export async function getAuditTrail(deps: DomainDeps, actor: Actor, contentHistId: string): Promise<string[]> {
  const trail = await withTenant(deps.db, actor.tenantId, (tx) => versionTrail(tx, deps.repository, contentHistId));
  return trail.map((version) => version.contenthistid ?? '');
}

/** contentManager.getDraftHist [contentManager.cfc:268-276]: the unapproved versions outside change sets. */
export function getDraftHist(deps: DomainDeps, actor: Actor, item: ItemRef): Promise<DraftHistRow[]> {
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.draftHist(tx, item));
}

/** contentManager.getPendingChangesets [contentManager.cfc:278-286]: the unapproved versions in change sets. */
export function getPendingChangesets(deps: DomainDeps, actor: Actor, item: ItemRef): Promise<PendingChangesetRow[]> {
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.pendingChangesets(tx, item));
}

/** contentManager.getArchiveHist [contentManager.cfc:288-296]: the approved versions no longer active. */
export function getArchiveHist(deps: DomainDeps, actor: Actor, item: ItemRef): Promise<DraftHistRow[]> {
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.archiveHist(tx, item));
}

/** contentManager.getHasDrafts [contentManager.cfc:298-306]: the draft history's record count. */
export async function getHasDrafts(deps: DomainDeps, actor: Actor, item: ItemRef): Promise<number> {
  return (await getDraftHist(deps, actor, item)).length;
}

/** contentManager.getItemCount [contentManager.cfc:308-316]: the active version summary of an item. */
export function getItemCount(deps: DomainDeps, actor: Actor, item: ItemRef): Promise<ItemCountRow[]> {
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.itemCount(tx, item));
}

// ---- Site Manager tree ----

/** A `cfoutput query startrow maxrows` window: 1-based `startRow` (default 1), `maxRows` (default every row). */
export interface RowWindow {
  startRow?: number;
  maxRows?: number;
}

/** The rows a window shows and the record count of the whole query. */
export interface TreePage<R> {
  rows: R[];
  recordCount: number;
}

/** The 0-based first row of `window` and its row cap, negative for every row. */
function windowBounds(window: RowWindow): { from: number; maxRows: number } {
  const startRow = window.startRow ?? 1;
  const maxRows = window.maxRows ?? -1;
  if (!Number.isInteger(startRow) || startRow < 1 || !Number.isInteger(maxRows)) {
    throw new RangeError('startRow must be a positive integer and maxRows an integer');
  }
  return { from: startRow - 1, maxRows };
}

/** The rows `window` selects from `rows`. */
function windowOf<R>(rows: R[], window: RowWindow): TreePage<R> {
  const { from, maxRows } = windowBounds(window);
  return { rows: maxRows < 0 ? rows.slice(from) : rows.slice(from, from + maxRows), recordCount: rows.length };
}

/** Arguments of `getKids`: contentManager.getKidsQuery's, with the window the listing pages by. */
export interface GetKidsArgs extends Omit<KidsArgs, 'today' | 'now'>, RowWindow {
  /** Legacy `today`, or the preview publish date or point in time that replaces it; defaults to the clock. */
  today?: Date;
}

/** contentManager.getKidsQuery [contentManager.cfc:2694-2737]: live navigable children, at most `size` (default 100, 0 for all). */
export async function getKids(deps: DomainDeps, actor: Actor, args: GetKidsArgs): Promise<TreePage<KidsRow>> {
  const { startRow, maxRows, today, ...query } = args;
  const now = deps.clock.now();
  const rows = await withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.kids(tx, { ...query, today: today ?? now, now }));
  return windowOf(await withPooledFiles(deps, actor, rows), { startRow, maxRows });
}

/** Arguments of `getNest`; dsp_nest.cfm windows the rows by `startrow` and `nextN`. */
export interface NestArgs extends RowWindow {
  parentId: string;
  siteId: string;
  /** Defaults to `orderno`. */
  sortBy?: string;
  /** Defaults to `asc`. */
  sortDirection?: string;
}

/** contentManager.getNest [contentManager.cfc:246-256]: the active children of `parentId` for the Site Manager tree, windowed in SQL. */
export async function getNest(deps: DomainDeps, actor: Actor, args: NestArgs): Promise<TreePage<NestRow>> {
  const { from, maxRows } = windowBounds(args);
  const query = { parentId: args.parentId, siteId: args.siteId, sortBy: args.sortBy ?? 'orderno', sortDirection: args.sortDirection ?? 'asc' };
  // A bound past Number.MAX_SAFE_INTEGER selects the rows that bound does, and would not bind as a bigint.
  const offset = Math.min(from, Number.MAX_SAFE_INTEGER);
  const limit = maxRows < 0 ? undefined : Math.min(maxRows, Number.MAX_SAFE_INTEGER);
  const page = await withTenant(deps.db, actor.tenantId, async (tx) => {
    const rows = await deps.repository.content.nest(tx, { ...query, offset, limit });
    // A page short of its cap ends the query, unless it is empty after row one.
    const ended = (limit === undefined || rows.length < limit) && (rows.length > 0 || from === 0);
    return { rows, recordCount: ended ? from + rows.length : await deps.repository.content.nestCount(tx, query) };
  });
  return { rows: await withPooledFiles(deps, actor, page.rows), recordCount: page.recordCount };
}

/** contentManager.getPageCount [contentManager.cfc:806-813]: `rsPageCount.counter`, the site's active pages, folders, files, calendars and galleries. */
export async function getPageCount(deps: DomainDeps, actor: Actor, siteId: string): Promise<number> {
  const [row] = await withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.pageCount(tx, { siteId }));
  return row?.counter ?? 0;
}

/** contentManager.getKidsCount [contentManager.cfc:3091-3097]: children live in the `menuType` window now, or merely active without `liveOnly`. */
export function getKidsCount(
  deps: DomainDeps,
  actor: Actor,
  args: { parentId: string; siteId: string; liveOnly?: boolean; menuType?: string },
): Promise<number> {
  return withTenant(deps.db, actor.tenantId, (tx) =>
    deps.repository.content.kidsCount(tx, {
      parentId: args.parentId,
      siteId: args.siteId,
      today: deps.clock.now(),
      liveOnly: args.liveOnly ?? true,
      type: args.menuType ?? 'default',
    }),
  );
}

// ---- drafts, approvals and the dashboard counts ----

/** Arguments of the draft and submission lists; `userId` defaults to the acting user (`session.mura.userID`). */
export interface UserListArgs extends DraftListPaging {
  siteId: string;
  userId?: string;
}

/** Arguments of the approval list; `membershipIds` defaults to the acting user's groups (`session.mura.membershipids`). */
export interface ApprovalsArgs extends DraftListPaging {
  siteId: string;
  membershipIds?: readonly string[];
}

/** sessionUserFacade `isAdminUser() or isSuperUser()`: S2, or the `Admin` group of the site's private user pool. */
async function isAdminOrSuperUser(deps: DomainDeps, actor: Actor, memberships: UserMemberships): Promise<boolean> {
  if (actor.s2) {
    return true;
  }
  if (!actor.isLoggedIn || memberships.names.length === 0) {
    return false;
  }
  return memberships.names.includes(`Admin;${(await sitePools(deps, actor)).privateUserPoolId};0`);
}

/** CF query-of-queries `select distinct contentid`: case-sensitive, NULL counted once. */
function distinctContentIds(rows: ReadonlyArray<{ contentid: string | null }>): number {
  return new Set(rows.map((row) => row.contentid)).size;
}

/** contentManager.getDraftList [contentManager.cfc:318-325]: the user's drafts newer than, or replacing, the active version. */
export function getDraftList(deps: DomainDeps, actor: Actor, args: UserListArgs): Promise<DraftListRow[]> {
  const { userId = actor.userId, ...paging } = args;
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.draftList(tx, { ...paging, userId }));
}

/** contentManager.getApprovalsQuery [contentManager.cfc:327-334]: pending requests, limited to the user's groups unless admin or super user. */
export async function getApprovalsQuery(deps: DomainDeps, actor: Actor, args: ApprovalsArgs): Promise<ApprovalListRow[]> {
  const { membershipIds, ...paging } = args;
  const memberships = await loadMemberships(deps, actor);
  const groupIds = (await isAdminOrSuperUser(deps, actor, memberships)) ? null : (membershipIds ?? memberships.groupIds);
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.approvalsQuery(tx, { ...paging, groupIds }));
}

/** contentManager.getSubmissionsQuery [contentManager.cfc:343-350]: the user's pending approval requests. */
export function getSubmissionsQuery(deps: DomainDeps, actor: Actor, args: UserListArgs): Promise<ApprovalListRow[]> {
  const { userId = actor.userId, ...paging } = args;
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.submissionsQuery(tx, { ...paging, userId }));
}

/** contentManager.getMyApprovalsCount [contentManager.cfc:3046-3053]: distinct items awaiting the user's approval. */
export async function getMyApprovalsCount(deps: DomainDeps, actor: Actor, args: { siteId: string }): Promise<number> {
  return distinctContentIds(await getApprovalsQuery(deps, actor, { siteId: args.siteId }));
}

/** contentManager.getMySubmissionsCount [contentManager.cfc:3055-3062]: distinct items the user submitted for approval. */
export async function getMySubmissionsCount(deps: DomainDeps, actor: Actor, args: { siteId: string }): Promise<number> {
  return distinctContentIds(await getSubmissionsQuery(deps, actor, { siteId: args.siteId }));
}

/** contentManager.getMyDraftsCount [contentManager.cfc:3064-3073]: the items of the user's drafts since `startDate`. */
export async function getMyDraftsCount(deps: DomainDeps, actor: Actor, args: { siteId: string; startDate?: Date | null }): Promise<number> {
  return distinctContentIds(await getDraftList(deps, actor, { siteId: args.siteId, startDate: args.startDate ?? null }));
}

/** contentManager.getMyExpiresCount [contentManager.cfc:3075-3083]: distinct items of the user expiring within a month or expired within a year. */
export async function getMyExpiresCount(deps: DomainDeps, actor: Actor, args: { siteId: string }): Promise<number> {
  const rows = await withTenant(deps.db, actor.tenantId, (tx) =>
    deps.repository.content.expiringContent(tx, { siteId: args.siteId, userId: actor.userId, today: deps.clock.now() }),
  );
  return distinctContentIds(rows);
}

/** contentManager.getMyLockedContentCount [contentManager.cfc:3085-3089]: the items the user holds locks on. */
export function getMyLockedContentCount(deps: DomainDeps, actor: Actor, args: { siteId: string }): Promise<number> {
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.lockedContentCount(tx, { siteId: args.siteId, userId: actor.userId }));
}

// ---- draft prompt ----

/** A version row of the draft prompt's `pendingchangesets` (titled by change set) or `yourapprovals` (by menu title) list. */
export interface DraftPromptRow {
  contenthistid: string;
  title: string;
  lastupdate: Date | null;
  lastupdateby: string;
}

/** contentManager.getDraftPromptData's struct without the flags draftpromptdata.cfm derives from it and the site's lock setting. */
export interface DraftPromptView {
  verdict: NodePerm;
  publishedHistoryId: string;
  hasDraft: boolean;
  hasDraftPending: boolean;
  historyId: string;
  /** The item's stats lock; legacy reads it only on sites with lockable nodes, which the renderer checks. */
  lockId: string;
  lockType: string;
  pendingChangesets: DraftPromptRow[];
  yourApprovals: DraftPromptRow[];
}

/** A row of the prompt's query-of-queries unions. */
interface PromptVersion {
  contenthistid: string | null;
  menutitle: string | null;
  lastupdate: Date | null;
  lastupdateby: string | null;
  approvalstatus: string | null;
  approvalgroupid: string | null;
  changesetid: string;
  changesetname: string;
}

function promptVersion(row: DraftHistRow | PendingByContentRow, changeset: { changesetid: string; changesetname: string }): PromptVersion {
  return {
    contenthistid: row.contenthistid,
    menutitle: row.menutitle,
    lastupdate: row.lastupdate,
    lastupdateby: row.lastupdateby,
    approvalstatus: row.approvalstatus,
    approvalgroupid: row.approvalgroupid,
    ...changeset,
  };
}

/** Query-of-queries `UNION` over the columns `keyOf` selects: duplicate rows dropped, first occurrence kept. */
function union<R>(rows: readonly R[], keyOf: (row: R) => readonly unknown[]): R[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(keyOf(row).map((value) => (value instanceof Date ? value.getTime() : value)));
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Query-of-queries `order by lastupdate`: stable, NULLs lowest. */
function byLastUpdate<R extends { lastupdate: Date | null }>(rows: readonly R[], direction: 'asc' | 'desc'): R[] {
  const time = (row: R): number => row.lastupdate?.getTime() ?? Number.NEGATIVE_INFINITY;
  return [...rows].sort((a, b) => (direction === 'asc' ? time(a) - time(b) : time(b) - time(a)) || 0);
}

function promptRow(row: { contenthistid: string | null; lastupdate: Date | null; lastupdateby: string | null }, title: string | null): DraftPromptRow {
  return { contenthistid: row.contenthistid ?? '', title: title ?? '', lastupdate: row.lastupdate, lastupdateby: row.lastupdateby ?? '' };
}

/** contentManager.getDraftPromptData [contentManager.cfc:2784-2888]: the draft and lock prompt's verdict, newest draft, approvals and lock. */
export async function getDraftPromptData(deps: DomainDeps, actor: Actor, contentId: string, siteId: string): Promise<DraftPromptView> {
  const read = await withTenant(deps.db, actor.tenantId, async (tx) => {
    const data = await deps.repository.content.draftPromptData(tx, { contentId, siteId });
    const { active } = data;
    if (active === null) {
      // A new bean has no crumbs (getCrumbArray walks its empty parentid) and reads the stats of contentid ''.
      return { ...data, crumbs: [], stats: await deps.repository.stats.readStats(tx, { contentId: '', siteId }) };
    }
    const crumbs = await deps.repository.content.crumbPath(tx, { contentId: active.contentid ?? '', siteId: active.siteid ?? '', path: active.path ?? '' });
    return { ...data, crumbs };
  });
  const verdict = await getNodePerm(deps, actor, read.crumbs);
  const { active, draftHist: history, pendingChangesets: pending } = read;
  const view: DraftPromptView = {
    verdict,
    publishedHistoryId: active?.contenthistid ?? '',
    hasDraft: false,
    hasDraftPending: false,
    historyId: '',
    lockId: read.stats?.lockid ?? '',
    lockType: read.stats?.locktype ?? '',
    pendingChangesets: pending.map((row) => promptRow(row, row.changesetname)),
    yourApprovals: [],
  };
  // contentDAO's new bean is active, with the lastupdate `now()` contentBean.init() gives it.
  const isActive = (active?.active ?? 1) !== 0;
  if (!isActive || (history.length === 0 && pending.length === 0)) {
    return view;
  }
  const editor = verdict === 'author' || verdict === 'editor';
  if (editor) {
    const since = active === null ? deps.clock.now() : active.lastupdate;
    const newer = history.filter((row) => since !== null && row.lastupdate !== null && row.lastupdate > since);
    const newDraft = byLastUpdate(
      union([...newer, ...pending], (row) => [row.contenthistid, row.menutitle, row.lastupdate, row.lastupdateby, row.approvalstatus]),
      'desc',
    );
    const [latest] = newDraft;
    if (latest !== undefined) {
      view.hasDraft = true;
      view.hasDraftPending = cfEq(latest.approvalstatus ?? '', 'Pending');
      view.historyId = latest.contenthistid ?? '';
    }
  }
  // Query-of-queries string comparisons are case-sensitive.
  let approvals = union(
    [
      ...history.filter((row) => row.approvalstatus === 'Pending').map((row) => promptVersion(row, { changesetid: '', changesetname: '' })),
      ...pending
        .filter((row) => row.approvalstatus === 'Pending')
        .map((row) => promptVersion(row, { changesetid: row.changesetid, changesetname: row.changesetname ?? '' })),
    ],
    (row) => [row.contenthistid, row.menutitle, row.lastupdate, row.lastupdateby, row.approvalstatus, row.approvalgroupid, row.changesetid, row.changesetname],
  );
  const memberships = await loadMemberships(deps, actor);
  if (!(await isAdminOrSuperUser(deps, actor, memberships))) {
    approvals = byLastUpdate(
      approvals.filter((row) => row.approvalgroupid !== null && memberships.groupIds.includes(row.approvalgroupid)),
      'asc',
    );
  } else if (!editor) {
    view.pendingChangesets = [];
  }
  view.yourApprovals = approvals.map((row) => promptRow(row, row.menutitle));
  return view;
}

// ---- session effects ----

/** An admin session write a Site Manager action asks for; the route layer applies it to the session. */
export type SessionEffect =
  | { kind: 'flatViewArgs'; siteId: string; tab: string }
  | { kind: 'copyInfo'; copySiteID: string; copyContentID: string; copyModuleID: string; copyAll: string };

/** carch.siteManagerTab [carch.cfc:516-526]: `session.flatViewArgs[siteId].tab`, keyed by the session's site (`session.siteID`), not `rc.siteid`. */
export function siteManagerTab(input: { siteId: string; tab: string }): SessionEffect {
  return { kind: 'flatViewArgs', siteId: input.siteId, tab: input.tab };
}

/** contentManager.saveCopyInfo [contentManager.cfc:2300-2310]: the item the Site Manager's paste copies. */
export function saveCopyInfo(input: { siteId: string; contentId: string; moduleId: string; copyAll: string }): SessionEffect {
  return { kind: 'copyInfo', copySiteID: input.siteId, copyContentID: input.contentId, copyModuleID: input.moduleId, copyAll: input.copyAll };
}

// ---- node and file locks ----

/** The content item a lock action names; `requestId` tags the changelog row. */
export interface LockTarget extends ItemRef {
  requestId?: string;
}

/** The stats lock id of an item, '' when it has no row or no lock. */
async function lockIdOf(tx: TenantTx, repo: ContentRepository, item: ItemRef): Promise<string> {
  return (await repo.stats.readStats(tx, item))?.lockid ?? '';
}

/** carch.edit `locknode` [carch.cfc:323-328]: node-locks the edited version's item unless another user holds a lock; true when written. */
export function lockNode(deps: DomainDeps, actor: Actor, target: LockTarget): Promise<boolean> {
  const item = { contentId: target.contentId, siteId: target.siteId };
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const lockId = await lockIdOf(tx, deps.repository, item);
    if (lockId !== '' && !cfEq(lockId, actor.userId)) {
      return false;
    }
    await deps.repository.stats.setLock(tx, { ...item, lockId: actor.userId, lockType: 'node' }, writeContextFor(actor, target.requestId));
    return true;
  });
}

/** What carch.lockFile answers: a redirect to the file download once locked, else legacy's empty `abort`. */
export type LockFileOutcome = { locked: true; location: string } | { locked: false };

/** carch.lockFile [carch.cfc:578-593]: an author, editor or S2 file-locks the item over any lock; `context` is configBean `getContext()`. */
export async function lockFile(deps: DomainDeps, actor: Actor, input: LockTarget & { context: string }): Promise<LockFileOutcome> {
  const item = { contentId: input.contentId, siteId: input.siteId };
  const { bean, crumbs } = await withTenant(deps.db, actor.tenantId, async (tx) => ({
    bean: await activeBean(tx, deps.repository, item),
    crumbs: await deps.repository.content.crumbPath(tx, item),
  }));
  const perm = await getNodePerm(deps, actor, crumbs);
  if (perm !== 'author' && perm !== 'editor' && !actor.s2) {
    return { locked: false };
  }
  await withGatedTenant(deps.db, actor.tenantId, (tx) =>
    deps.repository.stats.setLock(tx, { ...beanItem(bean), lockId: actor.userId, lockType: 'file' }, writeContextFor(actor, input.requestId)),
  );
  const fileId = bean.isNew === 0 ? (bean.version.fileid ?? '') : '';
  return { locked: true, location: `${input.context}/index.cfm/_api/render/file/?fileid=${fileId}&method=attachment` };
}

/** carch.unlockFile and carch.unlockNode: clears the active version's lock when held, by the actor or for an S2 actor. */
function unlock(deps: DomainDeps, actor: Actor, target: LockTarget): Promise<boolean> {
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const item = beanItem(await activeBean(tx, deps.repository, { contentId: target.contentId, siteId: target.siteId }));
    const lockId = await lockIdOf(tx, deps.repository, item);
    if (lockId === '' || !(cfEq(lockId, actor.userId) || actor.s2)) {
      return false;
    }
    await deps.repository.stats.clearLock(tx, item, writeContextFor(actor, target.requestId));
    return true;
  });
}

/** carch.unlockFile [carch.cfc:595-612]: returns whether the lock was cleared. */
export function unlockFile(deps: DomainDeps, actor: Actor, target: LockTarget): Promise<boolean> {
  return unlock(deps, actor, target);
}

/** carch.unlockNode [carch.cfc:614-628]: returns whether the lock was cleared. */
export function unlockNode(deps: DomainDeps, actor: Actor, target: LockTarget): Promise<boolean> {
  return unlock(deps, actor, target);
}
