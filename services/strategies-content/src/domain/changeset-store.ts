/** Change-set row primitives shared by content saves and change-set operations: the changesetBean, its validation, and changesetManager read, save, delete and removeItem inside the caller's transaction. */
import { cfListToArray, cfUuid } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { ChangesetInput, ContentRepository } from '../repo/repository.js';
import type { ChangesetRow, ContentRow } from '../repo/tables.js';
import { writeContextFor, type Actor, type LegacyErrors } from './context.js';
import { takeOut } from './trash.js';

/** changesetBean values as CFML holds them: unset dates are null, other unset values ''. */
export interface ChangesetBean {
  changesetid: string;
  siteid: string;
  name: string;
  description: string;
  created: Date | null;
  publishdate: Date | null;
  published: number;
  lastupdate: Date | null;
  lastupdateby: string;
  lastupdatebyid: string;
  remoteid: string;
  remotepubdate: Date | null;
  remotesourceurl: string;
  closedate: Date | null;
  /** CF list of the assigned category ids. */
  categoryid: string;
  /** CF list of the assigned tags. */
  tags: string;
  /** 1 until the bean is loaded from a stored row. */
  isnew: 0 | 1;
  errors: LegacyErrors;
}

/** The bean values a caller may supply to `newChangesetBean`. */
export type ChangesetValues = Partial<Omit<ChangesetBean, 'isnew' | 'errors'>>;

/** changesetManager.read arguments: with `siteId`, `name` wins over `remoteId`, which wins over `changesetId`. */
export interface ChangesetReadKey {
  changesetId?: string;
  name?: string;
  remoteId?: string;
  siteId?: string;
}

/** `left(…, 50)` of changesetBean's `lastUpdateBy`. */
const AUDIT_NAME_LENGTH = 50;

/** CF `trim`: drops leading and trailing characters at or below U+0020. */
function cfTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/** A stored text column as bean.setValue holds it: NULL as '', trimmed (which also drops `char(35)` padding). */
function text(value: string | null): string {
  return cfTrim(value ?? '');
}

/** The items a `cfloop list` visits, each trimmed as the ORM setValue stores it. */
function listItems(list: string): string[] {
  return cfListToArray(list).map(cfTrim);
}

/** `values` without the keys whose value is undefined. */
function definedValues(values: ChangesetValues): ChangesetValues {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as ChangesetValues;
}

/** changesetBean.init: `created` and `lastUpdate` now, the audit fields from a logged-in actor, then `values`; the id defaults to a new CF UUID. */
export function newChangesetBean(actor: Actor, clock: Clock, values: ChangesetValues = {}): ChangesetBean {
  const now = clock.now();
  const bean: ChangesetBean = {
    changesetid: '',
    siteid: '',
    name: '',
    created: now,
    description: '',
    publishdate: null,
    published: 0,
    remoteid: '',
    remotesourceurl: '',
    remotepubdate: null,
    lastupdate: new Date(now.getTime()),
    lastupdateby: actor.isLoggedIn ? actor.fullName.slice(0, AUDIT_NAME_LENGTH) : '',
    lastupdatebyid: actor.isLoggedIn ? actor.userId : '',
    closedate: null,
    categoryid: '',
    tags: '',
    isnew: 1,
    errors: {},
    ...definedValues(values),
  };
  // getChangesetID creates the id on first read, which every caller of a new bean makes.
  return bean.changesetid === '' ? { ...bean, changesetid: cfUuid() } : bean;
}

/** bean.set(rs) of a stored row over the init defaults: every column replaces its default, NULL dates as unset and a NULL `published` as 0. */
export function loadedBean(row: ChangesetRow): ChangesetBean {
  return {
    changesetid: text(row.changesetid),
    siteid: text(row.siteid),
    name: text(row.name),
    description: text(row.description),
    created: row.created,
    publishdate: row.publishdate,
    published: row.published ?? 0,
    lastupdate: row.lastupdate,
    lastupdateby: text(row.lastupdateby).slice(0, AUDIT_NAME_LENGTH),
    lastupdatebyid: text(row.lastupdatebyid),
    remoteid: text(row.remoteid),
    remotepubdate: row.remotepubdate,
    remotesourceurl: text(row.remotesourceurl),
    closedate: row.closedate,
    categoryid: '',
    tags: '',
    isnew: 0,
    errors: {},
  };
}

/** changesetManager.read's select: a site's change set by name or remote id, else by id (within the site when one is given). */
async function findRow(tx: TenantTx, repository: ContentRepository, key: ChangesetReadKey): Promise<ChangesetRow | null> {
  const siteId = key.siteId ?? '';
  if (siteId !== '' && (key.name ?? '') !== '') {
    return repository.changesets.findChangeset(tx, { name: key.name ?? '', siteId });
  }
  if (siteId !== '' && (key.remoteId ?? '') !== '') {
    return repository.changesets.findChangeset(tx, { remoteId: key.remoteId ?? '', siteId });
  }
  const row = await repository.changesets.findChangeset(tx, { changesetId: key.changesetId ?? '' });
  // `siteID = ?` under SQL Server's case-insensitive collation.
  return row === null || siteId === '' || text(row.siteid).toLowerCase() === siteId.toLowerCase() ? row : null;
}

/** changesetManager.read (and changesetBean.loadBy): the stored change set with its category and tag lists, else a new bean of `key.siteId`. */
export async function readChangesetInTx(
  tx: TenantTx,
  repository: ContentRepository,
  key: ChangesetReadKey,
  actor: Actor,
  clock: Clock,
): Promise<ChangesetBean> {
  const row = await findRow(tx, repository, key);
  if (row === null) {
    // A new bean's id is fresh, so legacy's assignment selects find nothing.
    return newChangesetBean(actor, clock, (key.siteId ?? '') === '' ? {} : { siteid: key.siteId });
  }
  const bean = loadedBean(row);
  const categoryIds = await repository.changesets.assignedCategoryIds(tx, { changesetId: bean.changesetid });
  const tags = await repository.changesets.assignedTags(tx, { changesetId: bean.changesetid });
  return { ...bean, categoryid: cfTrim(categoryIds.join(',')), tags: cfTrim(tags.join(',')) };
}

/**
 * changesetBean.validate: the beanValidator `required` rules with Masa's default `stricthtml` off. `changesetID` and
 * `published` always pass, because the id is created when read and `published` is numeric.
 */
export function validateChangeset(bean: ChangesetBean): LegacyErrors {
  const errors: LegacyErrors = {};
  for (const [property, value] of [['siteID', bean.siteid], ['name', bean.name]] as const) {
    if (value === '') {
      errors[property] = `The property named '${property}' is not valid`;
    }
  }
  return errors;
}

/** The tchangesets columns changesetManager.save binds from the bean; the repository stores the dates to the minute. */
function changesetColumns(bean: ChangesetBean): Omit<ChangesetInput, 'changesetid'> {
  return {
    siteid: bean.siteid,
    name: bean.name,
    description: bean.description,
    publishdate: bean.publishdate,
    published: bean.published,
    lastupdateby: bean.lastupdateby,
    lastupdatebyid: bean.lastupdatebyid,
    remoteid: bean.remoteid,
    remotepubdate: bean.remotepubdate,
    remotesourceurl: bean.remotesourceurl,
    closedate: bean.closedate,
  };
}

/**
 * changesetBean.save then changesetManager.save: a logged-in actor stamps `lastUpdateBy`/`lastUpdateByID`; with no
 * validation errors the stored row is updated (assignments deleted) or a new one inserted, then taken out of the trash,
 * and each listed category and tag is assigned once. The repository stamps `created` and `lastupdate` from its own
 * clock, so none is taken here. Returns the bean as legacy leaves it, with its errors.
 */
export async function saveChangesetInTx(
  tx: TenantTx,
  repository: ContentRepository,
  bean: ChangesetBean,
  actor: Actor,
  write: WriteContext = writeContextFor(actor),
): Promise<ChangesetBean> {
  const saved: ChangesetBean = {
    ...bean,
    changesetid: bean.changesetid === '' ? cfUuid() : bean.changesetid,
    ...(actor.isLoggedIn ? { lastupdateby: cfTrim(actor.fullName.slice(0, AUDIT_NAME_LENGTH)), lastupdatebyid: actor.userId } : {}),
  };
  saved.errors = validateChangeset(saved);
  if (Object.keys(saved.errors).length > 0) {
    return saved;
  }
  const columns = changesetColumns(saved);
  const assignments = { categoryIds: listItems(saved.categoryid), tags: listItems(saved.tags) };
  const updated = await repository.changesets.updateChangeset(tx, saved.changesetid, columns, assignments, write);
  if (updated === null) {
    await repository.changesets.insertChangeset(tx, { ...columns, changesetid: saved.changesetid }, assignments, write);
    takeOut({ ...saved });
  }
  return saved;
}

/** changesetManager.delete's row deletes: the change set and its category and tag assignments; the caller throws it in first. */
export function deleteChangesetRowsInTx(
  tx: TenantTx,
  repository: ContentRepository,
  changesetId: string,
  write?: WriteContext,
): Promise<ChangesetRow | null> {
  return repository.changesets.deleteChangeset(tx, { changesetId }, write);
}

/** changesetManager.removeItem: detaches version `contentHistId` from the change set; returns the versions it changed. */
export function removeItemInTx(
  tx: TenantTx,
  repository: ContentRepository,
  changesetId: string,
  contentHistId: string,
  write?: WriteContext,
): Promise<ContentRow[]> {
  return repository.changesets.removeItem(tx, { changesetId, contentHistId }, write);
}
