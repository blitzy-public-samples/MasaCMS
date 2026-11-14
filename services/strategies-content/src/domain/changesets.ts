/** Change sets: the cchangesets admin operations, changesetManager.publish and rollback, and the scheduled publish step. */
import {
  cfDateAdd,
  cfDateTimeFormat,
  cfEq,
  cfIsDateText,
  cfIsNumeric,
  cfListToArray,
  cfLsIsDate,
  cfLsParseDateTime,
  cfNumberString,
  cfParseDateTimeText,
  cfTimestampParam,
  cfToNumber,
  cfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { registeredTenants, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import type { ChangesetAssignmentRow, ChangesetFeedArgs } from '../repo/repository.js';
import type { ChangesetRollbackRow, ChangesetRow, ContentRow, TrashRow } from '../repo/tables.js';
import { loadRequest, saveRequest } from './approval-requests.js';
import {
  deleteChangesetRowsInTx,
  loadedBean,
  readChangesetInTx,
  removeItemInTx,
  saveChangesetInTx,
  type ChangesetBean,
} from './changeset-store.js';
import { approveVersion, deleteVersionInTransaction, parseDateArg, type ContentDeps, type ContentSaveSite, type SaveContentResult } from './content.js';
import { writeContextFor, type Actor, type DomainDeps, type LegacyErrors, type MailNotice } from './context.js';
import { createTrashCounter, deleteMarkerAssignments, deleteMarkers, deletedParentId, throwIn, trashObjectSubType, trashObjectType, type DeleteMarkers } from './trash.js';
// TrashEntry.values must be the bean struct in ACF iteration order, which only wddx.ts's cfStruct computes.
import { WddxDate, cfStruct, wddxNumber, type WddxStruct, type WddxValue } from './wddx.js';

export * from './changeset-store.js';

/** getAssignmentsIterator module ids of cChangesets.assignments: site tree, components, forms and variations. */
const SITE_TREE_MODULE_ID = '00000000000000000000000000000000000';
const COMPONENT_MODULE_ID = '00000000000000000000000000000000003';
const FORM_MODULE_ID = '00000000000000000000000000000000004';
const VARIATION_MODULE_ID = '00000000000000000000000000000000099';

/** cChangesets.list's `setNextN(20)`. */
export const CHANGESET_LIST_NEXT_N = 20;

/** Not run: queryParam's contentRenderer.setDynamicContent of list criteria, so `[mura]` tags in a keyword match literally. */
export const CHANGESET_LIST_UNBUILT = ['contentRenderer.setDynamicContent'] as const;

/** Plugin events changesetManager.publish announces; plugins run only on legacy, so nothing listens here. */
export const PUBLISH_EVENTS_UNBUILT = ['onBeforeChangeSetPublish', 'onAfterChangeSetPublish', 'onAfterChangeSetPublishFailure'] as const;

/** Request values as the cchangesets controller reads them from `rc`; key case is ignored. */
export type ChangesetParams = Readonly<Record<string, unknown>>;

/** An operation's value and the error legacy raised after committing the writes before it. */
interface Outcome<T> {
  value: T;
  error?: Error;
}

/** Commits are done: raises the error legacy raised after its writes, else returns the value. */
function settle<T>(outcome: Outcome<T>): T {
  if (outcome.error !== undefined) throw outcome.error;
  return outcome.value;
}

/** `rc[key]` as CFML resolves it, ignoring key case; undefined when absent. */
function param(rc: ChangesetParams, key: string): unknown {
  const wanted = key.toLowerCase();
  const found = Object.keys(rc).find((name) => name.toLowerCase() === wanted);
  return found === undefined ? undefined : rc[found];
}

/** A form value as CFML text; repeated fields arrive as a comma list. */
function formText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map(formText).join(',');
  return value === undefined || value === null ? '' : String(value);
}

/** `rc[key]` as text, else the controller's `param default`. */
function paramText(rc: ChangesetParams, key: string, fallback = ''): string {
  const value = param(rc, key);
  return value === undefined ? fallback : formText(value);
}

/** The site monitor's actor: no session user, acting for the site and tenant of `scope`. */
function systemActor(scope: Pick<Actor, 'siteId' | 'tenantId'>): Actor {
  return { userId: '', fullName: '', isLoggedIn: false, s2: false, roles: [], siteId: scope.siteId, tenantId: scope.tenantId };
}

// ---- cChangesets.list ----

/** cChangesets.list's iterator page and the request value the view links with. */
export interface ChangesetListResult {
  /** The page's change sets as changesetIterator packages them (`isnew` stays 1, no category or tag lists). */
  changesets: ChangesetBean[];
  /** Rows of the whole feed (`getRecordcount`). */
  recordCount: number;
  /** The iterator's page index after `setPage(rc.page)`. */
  pageIndex: number;
  nextN: number;
  /** `rc.stopdate` after the action: the day after a valid stop date, else the posted text. */
  stopdate: Date | string;
}

/** queryParam.setCriteria of a `date` param: the criteria's date part, or null when the param is invalid and skipped. */
function dateCriteria(value: Date | string): Date | null {
  let at: Date;
  if (value instanceof Date) at = value;
  else if (cfLsIsDate(value)) at = cfLsParseDateTime(value);
  else if (cfIsDateText(value)) at = cfParseDateTimeText(value);
  else return null;
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/** cChangesets.list's feed params (cchangesets.cfc:97-138) over `rc` with before()'s defaults. */
function listFeedArgs(deps: DomainDeps, rc: ChangesetParams): { args: ChangesetFeedArgs; stopdate: Date | string } {
  const startdate = paramText(rc, 'startdate');
  let stopdate: Date | string = paramText(rc, 'stopdate');
  const publishDateFrom: Date[] = [];
  const args: ChangesetFeedArgs = { siteId: paramText(rc, 'siteid'), publishDateFrom };
  const from = cfIsDateText(startdate) ? dateCriteria(startdate) : null;
  if (from !== null) publishDateFrom.push(from);
  if (cfIsDateText(stopdate)) {
    stopdate = cfDateAdd('d', 1, cfTimestampParam(stopdate));
    args.publishDateTo = dateCriteria(stopdate) ?? undefined;
    // Without a start date the feed also requires a publish date 100 years ahead, so it matches nothing.
    const far = cfIsDateText(startdate) ? null : dateCriteria(cfDateAdd('yyyy', 100, deps.clock.now()));
    if (far !== null) publishDateFrom.push(far);
  }
  const keywords = paramText(rc, 'keywords');
  if (keywords !== '') args.nameContains = keywords;
  const tags = paramText(rc, 'tags');
  if (tags !== '') args.tags = cfListToArray(tags);
  const categoryIds = paramText(rc, 'categoryid');
  if (categoryIds !== '') args.categoryIds = cfListToArray(categoryIds);
  return { args, stopdate };
}

/** cChangesets.list: one 20-row page of the site's change sets narrowed by publish date, name, tags and categories. */
export async function listChangesets(deps: DomainDeps, actor: Actor, rc: ChangesetParams): Promise<ChangesetListResult> {
  const { args, stopdate } = listFeedArgs(deps, rc);
  const page = param(rc, 'page') ?? 1;
  if (!cfIsNumeric(page)) throw new TypeError('The PAGEINDEX argument passed to the setPageIndex function is not of type numeric.');
  let pageIndex = cfToNumber(page);
  const recordIndex = (pageIndex - 1) * CHANGESET_LIST_NEXT_N;
  const usable = Number.isInteger(recordIndex) && recordIndex >= 0;
  // `name LIKE NULL`: queryParam turns the criteria 'null' into SQL NULL, so nothing matches.
  const matchesNothing = args.nameContains !== undefined && cfEq(args.nameContains, 'null');
  const found = await withTenant(deps.db, actor.tenantId, async (tx) => {
    const read = (offset: number) =>
      matchesNothing
        ? Promise.resolve({ rows: [] as ChangesetRow[], total: 0 })
        : deps.repository.changesets.changesetFeedPage(tx, args, { limit: CHANGESET_LIST_NEXT_N, offset });
    const first = await read(usable ? recordIndex : 0);
    if (recordIndex > first.total) {
      pageIndex = 1;
      return usable ? read(0) : first;
    }
    if (!usable) throw new RangeError(`Row ${recordIndex + 1} of the change-set feed does not exist.`);
    return first;
  });
  return {
    changesets: found.rows.map((row) => ({ ...loadedBean(row), isnew: 1 })),
    recordCount: found.total,
    pageIndex,
    nextN: CHANGESET_LIST_NEXT_N,
    stopdate,
  };
}

// ---- edit, save, delete, assignments and removeItem ----

/** changesetManager.read(changesetID) of cChangesets.edit: the stored change set, else a new bean of a fresh id. */
export function readChangeset(deps: DomainDeps, actor: Actor, changesetId: string): Promise<ChangesetBean> {
  return withTenant(deps.db, actor.tenantId, (tx) => readChangesetInTx(tx, deps.repository, { changesetId }, actor, deps.clock));
}

/** parseDateArg as the date setters store it; a value that is no date leaves the column unset. */
function beanDate(value: unknown): Date | null {
  const parsed = parseDateArg(value);
  return parsed instanceof Date ? parsed : null;
}

/** Bean values bean.setValue stores trimmed (setCategoryID trims too). */
type TextField = 'changesetid' | 'siteid' | 'name' | 'description' | 'remoteid' | 'remotesourceurl' | 'lastupdatebyid' | 'tags' | 'categoryid';
const TEXT_FIELDS: ReadonlySet<string> = new Set<TextField>([
  'changesetid', 'siteid', 'name', 'description', 'remoteid', 'remotesourceurl', 'lastupdatebyid', 'tags', 'categoryid',
]);
/** Bean values whose setters parse a date (parseDateArg). */
type DateField = 'created' | 'publishdate' | 'lastupdate' | 'remotepubdate' | 'closedate';
const DATE_FIELDS: ReadonlySet<string> = new Set<DateField>(['created', 'publishdate', 'lastupdate', 'remotepubdate', 'closedate']);

/** changesetBean.set(rc): each request value through its setter; keys changesetManager.save never persists are dropped. */
export function setChangesetValues(bean: ChangesetBean, rc: ChangesetParams): ChangesetBean {
  const next: ChangesetBean = { ...bean };
  for (const [key, value] of Object.entries(rc)) {
    const field = key.toLowerCase();
    if (TEXT_FIELDS.has(field)) next[field as TextField] = javaTrim(formText(value));
    else if (DATE_FIELDS.has(field)) next[field as DateField] = beanDate(value);
    else if (field === 'lastupdateby') next.lastupdateby = javaTrim(formText(value)).slice(0, 50);
    else if (field === 'published' && cfIsNumeric(value)) next.published = cfToNumber(value);
  }
  return next;
}

/** cChangesets.save's outcome: the saved (or invalid) bean and whether the action redirects to `cChangesets.list`. */
export interface ChangesetSaveResult {
  changeset: ChangesetBean;
  errors: LegacyErrors;
  redirect: boolean;
}

/** cChangesets.save after its CSRF check: `read(rc.changesetID).set(rc).save()` in one gated transaction. */
export async function saveChangeset(deps: DomainDeps, actor: Actor, rc: ChangesetParams): Promise<ChangesetSaveResult> {
  const changesetId = param(rc, 'changesetid');
  if (changesetId === undefined) throw new Error('Element CHANGESETID is undefined in ARGUMENTS.RC.');
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const read = await readChangesetInTx(tx, deps.repository, { changesetId: formText(changesetId) }, actor, deps.clock);
    const saved = await saveChangesetInTx(tx, deps.repository, setChangesetValues(read, rc), actor);
    return { changeset: saved, errors: saved.errors, redirect: Object.keys(saved.errors).length === 0 };
  });
}

/** A date value as cfwddx writes it: a dateTime, or the empty string of an unset date. */
function wddxDate(value: Date | null): WddxValue {
  return value === null ? '' : new WddxDate(value);
}

/** changesetBean.getAllValues() as throwIn serializes it: the init assignments in order, stored values over them, then the markers. */
export function changesetStruct(bean: ChangesetBean, markers: DeleteMarkers): WddxStruct {
  const loaded = bean.isnew === 0;
  const isNew: WddxValue = loaded ? '0' : wddxNumber(1);
  return cfStruct([
    ['ISNEW', isNew],
    ['ERRORS', cfStruct([])],
    ['FROMMURACACHE', false],
    ['INSTANCEID', cfUuid()],
    ['ADDOBJECTS', []],
    ['REMOVEOBJECTS', []],
    // A new bean creates its id only when throwIn reads the id after serializing.
    ['CHANGESETID', loaded ? bean.changesetid : ''],
    ['SITEID', bean.siteid],
    ['NAME', bean.name],
    ['CREATED', wddxDate(bean.created)],
    ['DESCRIPTION', bean.description],
    ['PUBLISHDATE', wddxDate(bean.publishdate)],
    ['PUBLISHED', wddxNumber(bean.published)],
    ['REMOTEID', bean.remoteid],
    ['REMOTESOURCEURL', bean.remotesourceurl],
    ['REMOTEPUBDATE', wddxDate(bean.remotepubdate)],
    // init assigns `lastUpdate="#now()#"`, the timestamp's text, which a stored row replaces with its date.
    ['LASTUPDATE', loaded || bean.lastupdate === null ? wddxDate(bean.lastupdate) : `{ts '${cfDateTimeFormat(bean.lastupdate, 'yyyy-mm-dd HH:nn:ss')}'}`],
    ['LASTUPDATEBY', bean.lastupdateby],
    ['CLOSEDATE', wddxDate(bean.closedate)],
    ['ISNEW', isNew],
    ['CATEGORYID', bean.categoryid],
    ['TAGS', bean.tags],
    ['ERRORS', cfStruct([])],
    ['LASTUPDATEBY', bean.lastupdateby],
    ['LASTUPDATEBYID', bean.lastupdatebyid],
    ...deleteMarkerAssignments(markers),
  ]);
}

/** changesetManager.delete's outcome: the bean thrown in, its trash row (null when one existed) and the deleted row. */
export interface ChangesetDeletion {
  changeset: ChangesetBean;
  trash: TrashRow | null;
  deleted: ChangesetRow | null;
}

/** cChangesets.delete: changesetManager.delete re-reads the id, throws the bean in, then deletes it with its assignments. */
export function deleteChangeset(deps: DomainDeps, actor: Actor, changesetId: string): Promise<ChangesetDeletion> {
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const repo = deps.repository;
    const read = await readChangesetInTx(tx, repo, { changesetId }, actor, deps.clock);
    const bean = await readChangesetInTx(tx, repo, { changesetId: read.changesetid }, actor, deps.clock);
    const markers = deleteMarkers(deps.clock.now());
    const values = changesetStruct(bean, markers);
    const write = writeContextFor(actor);
    const trash = await throwIn(
      tx,
      repo,
      {
        objectClass: 'changeset',
        objectId: bean.changesetid,
        parentId: deletedParentId(values),
        siteId: bean.siteid !== '' ? bean.siteid : actor.siteId,
        label: bean.name,
        objectType: trashObjectType(values, 'changeset'),
        objectSubType: trashObjectSubType(values),
        values,
        ...markers,
      },
      actor,
      createTrashCounter(),
      write,
    );
    const deleted = await deleteChangesetRowsInTx(tx, repo, read.changesetid, write);
    return { changeset: bean, trash, deleted };
  });
}

/** cChangesets.assignments' iterators by module and the change set itself. */
export interface ChangesetAssignments {
  changeset: ChangesetBean;
  site: ChangesetAssignmentRow[];
  component: ChangesetAssignmentRow[];
  form: ChangesetAssignmentRow[];
  /** Read only when configBean `variations` is on. */
  variation?: ChangesetAssignmentRow[];
}

/** cChangesets.assignments: the versions assigned to the change set matching `keywords`, one list per module. */
export function assignments(deps: DomainDeps, actor: Actor, args: { changesetId: string; keywords?: string }): Promise<ChangesetAssignments> {
  return withTenant(deps.db, actor.tenantId, async (tx) => {
    const repo = deps.repository;
    const list = (moduleId: string): Promise<ChangesetAssignmentRow[]> =>
      repo.changesets.assignmentsQuery(tx, { changesetId: args.changesetId, keywords: args.keywords ?? '', moduleId });
    const site = await list(SITE_TREE_MODULE_ID);
    const component = await list(COMPONENT_MODULE_ID);
    const form = await list(FORM_MODULE_ID);
    const variation = deps.config.variations ? await list(VARIATION_MODULE_ID) : undefined;
    const changeset = await readChangesetInTx(tx, repo, { changesetId: args.changesetId }, actor, deps.clock);
    return variation === undefined ? { changeset, site, component, form } : { changeset, site, component, form, variation };
  });
}

/** cChangesets.removeitem after its CSRF check: detaches the version from the change set; returns the versions changed. */
export function removeItem(deps: DomainDeps, actor: Actor, changesetId: string, contentHistId: string): Promise<ContentRow[]> {
  return withGatedTenant(deps.db, actor.tenantId, (tx) => removeItemInTx(tx, deps.repository, changesetId, contentHistId, writeContextFor(actor)));
}

// ---- publish and rollback ----

/** changesetManager.publish's outcome. */
export interface ChangesetPublishResult {
  /** False when a pending approval skipped the publish. */
  published: boolean;
  /** The change set as the publish saved it; null when skipped. */
  changeset: ChangesetBean | null;
  /** Mail the content saves would send; returned, never sent. */
  notices: MailNotice[];
}

/** changesetManager.publish in `tx`, skipped while an assigned version awaits approval. */
async function publishInTx(tx: TenantTx, deps: ContentDeps, actor: Actor, site: ContentSaveSite, changesetId: string): Promise<Outcome<ChangesetPublishResult>> {
  const repo = deps.repository;
  if ((await repo.changesets.hasPendingApprovals(tx, { changesetId })) > 0) {
    return { value: { published: false, changeset: null, notices: [] } };
  }
  const items = await repo.changesets.assignmentsQuery(tx, { changesetId });
  const changeset = await readChangesetInTx(tx, repo, { changesetId }, actor, deps.clock);
  const write = writeContextFor(actor);
  const notices: MailNotice[] = [];
  for (const item of items) {
    const siteId = item.siteid ?? '';
    // The iterator's row keeps the assigned version's id after the save, so that id is re-saved, deleted and recorded.
    const contentHistId = item.contenthistid ?? '';
    const [current] = await repo.content.readActive(tx, { contentId: item.contentid ?? '', siteId });
    const saved = await approveVersion(tx, deps, actor, site, contentHistId, { approvalChainOverride: true });
    notices.push(...saved.notices);
    if (saved.afterCommitError !== undefined) {
      return { value: { published: false, changeset: null, notices }, error: saved.afterCommitError };
    }
    const requestId = item.requestid ?? '';
    if (requestId !== '') {
      const request = await loadRequest(tx, repo, { requestId });
      await saveRequest(tx, repo, { ...request.values, contenthistid: contentHistId }, actor, site);
      const [previous] = await repo.content.readVersion(tx, { contentHistId });
      // contentBean.deleteVersion removes only an inactive version.
      if (previous !== undefined && !Number(previous.active)) {
        await deleteVersionInTransaction(tx, deps, actor, site, { contentHistId, siteId });
      }
    }
    await repo.changesets.insertRollback(
      tx,
      {
        changesethistid: contentHistId,
        changesetid: item.changesetid ?? changesetId,
        // contentBean.getContentHistID creates an id for an item without an active version.
        previoushistid: current?.contenthistid ?? cfUuid(),
        siteid: siteId,
      },
      write,
    );
  }
  const saved = await saveChangesetInTx(tx, repo, { ...changeset, published: 1, publishdate: deps.clock.now() }, actor, write);
  return { value: { published: true, changeset: saved, notices } };
}

/** changesetManager.publish in one gated transaction (cChangesets.publish has no CSRF check); `byScheduler` acts without a session user. */
export async function publish(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  changesetId: string,
  byScheduler = false,
): Promise<ChangesetPublishResult> {
  const publisher = byScheduler ? systemActor(actor) : actor;
  return settle(await withGatedTenant(deps.db, publisher.tenantId, (tx) => publishInTx(tx, deps, publisher, site, changesetId)));
}

/** changesetRollBack.rollback (changesetRollBackBean.cfc:8-31): re-activates the replaced version, else hides the first one. */
async function rollbackItem(
  tx: TenantTx,
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  row: ChangesetRollbackRow,
): Promise<SaveContentResult | null> {
  const repo = deps.repository;
  const previousHistId = row.previoushistid ?? '';
  if ((await repo.content.readVersion(tx, { contentHistId: previousHistId })).length > 0) {
    return approveVersion(tx, deps, actor, site, previousHistId, { approvalChainOverride: true });
  }
  const changesetHistId = row.changesethistid ?? '';
  if ((await repo.content.readVersion(tx, { contentHistId: changesetHistId })).length > 0) {
    return approveVersion(tx, deps, actor, site, changesetHistId, { approvalChainOverride: true, display: 0 });
  }
  return null;
}

/** changesetBean.rollback's outcome. */
export interface ChangesetRollbackResult {
  changeset: ChangesetBean;
  notices: MailNotice[];
}

/** changesetBean.rollback in one gated transaction: a published change set rolls back its versions, then any is saved unpublished. */
export async function rollback(deps: ContentDeps, actor: Actor, site: ContentSaveSite, changesetId: string): Promise<ChangesetRollbackResult> {
  const outcome = await withGatedTenant(deps.db, actor.tenantId, async (tx): Promise<Outcome<ChangesetRollbackResult>> => {
    const repo = deps.repository;
    const changeset = await readChangesetInTx(tx, repo, { changesetId }, actor, deps.clock);
    const notices: MailNotice[] = [];
    if (changeset.published) {
      for (const row of await repo.changesets.rollbackRows(tx, { changesetId: changeset.changesetid, siteId: changeset.siteid })) {
        const saved = await rollbackItem(tx, deps, actor, site, row);
        notices.push(...(saved?.notices ?? []));
        if (saved?.afterCommitError !== undefined) return { value: { changeset, notices }, error: saved.afterCommitError };
      }
    }
    const saved = await saveChangesetInTx(tx, repo, { ...changeset, published: 0, publishdate: null }, actor);
    return { value: { changeset: saved, notices } };
  });
  return settle(outcome);
}

// ---- scheduled publish ----

/** What the scheduled publish step runs against. */
export interface ScheduledPublishDeps extends ContentDeps {
  /** The site settings the content saves of `tenantId`, registered as `siteId`, read. */
  siteFor(tenantId: string, siteId: string): ContentSaveSite | Promise<ContentSaveSite>;
  /** The step's `now()` for selecting due change sets; the clock's time when omitted. */
  cutoff?: Date;
}

/** One due change set the step reached. */
export interface ScheduledPublishItem {
  tenantId: string;
  siteId: string;
  changesetId: string;
  /** False when a pending approval skipped it. */
  published: boolean;
}

/** The scheduled publish step's outcome, in publish order. */
export interface ScheduledPublishResult {
  changesets: ScheduledPublishItem[];
}

/** changesetManager.publishBySchedule: per registered tenant, in its own gated transaction, publishes the change sets due by the cutoff, earliest first. */
export async function publishScheduledChangesets(deps: ScheduledPublishDeps): Promise<ScheduledPublishResult> {
  const cutoff = deps.cutoff ?? deps.clock.now();
  const changesets: ScheduledPublishItem[] = [];
  for (const { tenantId, siteId } of await registeredTenants(deps.db)) {
    const actor = systemActor({ siteId, tenantId });
    const outcome = await withGatedTenant(deps.db, tenantId, async (tx): Promise<Outcome<ScheduledPublishItem[]>> => {
      const due = await deps.repository.changesets.pendingScheduledChangesets(tx, cutoff);
      const items: ScheduledPublishItem[] = [];
      if (due.length === 0) return { value: items };
      const site = await deps.siteFor(tenantId, siteId);
      for (const changesetId of due) {
        const published = await publishInTx(tx, deps, actor, site, changesetId);
        items.push({ tenantId, siteId, changesetId, published: published.value.published });
        if (published.error !== undefined) return { value: items, error: published.error };
      }
      return { value: items };
    });
    changesets.push(...outcome.value);
    if (outcome.error !== undefined) throw outcome.error;
  }
  return { changesets };
}
