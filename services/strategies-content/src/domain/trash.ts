// Masa trashManager throwIn and takeOut (trashManager.cfc:155-296, 405-443) for strategies-content's share of ttrash: the
// content, changeset, category and feed object classes, stored in the `content.trash` unit.
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { cfDateTimeFormat, cfUuid } from '@opt2/platform/legacy-compat';
import type { ContentRepository } from '../repo/repository.js';
import type { TrashRow } from '../repo/tables.js';
import { writeContextFor, type Actor } from './context.js';
import { cfml2wddx, wddxStructGet, WddxNumber, type WddxStruct, type WddxValue } from './wddx.js';

/** The ttrash object classes strategies-content owns. */
export type TrashObjectClass = 'content' | 'changeset' | 'category' | 'feed';

/** One deleted object as throwIn stores it; callers read each field from the deleted bean. */
export interface TrashEntry {
  objectClass: TrashObjectClass;
  /** The bean value named by getIDString: `contentID` for content, else the primary key. */
  objectId: string;
  /** `deletedParentId(values)`. */
  parentId: string;
  /** The bean's siteid. */
  siteId: string;
  /** The bean's getInstanceName(). */
  label: string;
  /** `trashObjectType(values, entityName)`. */
  objectType: string;
  /** `trashObjectSubType(values)`. */
  objectSubType: string;
  /** The bean's getAllValues() in ACF iteration order, delete markers included (`deleteMarkerAssignments`). */
  values: WddxStruct;
  /** muraDeleteDateTime, shared by every item of a recursive delete. */
  deletedDate: Date;
  /** muraDeleteID, shared by every item of a recursive delete. */
  deleteId: string;
}

/** The request-scoped `request["delete#hash(deleteID)#"]` counters that number throw-ins sharing a delete id. */
export interface TrashRequestCounter {
  /** Increments and returns the count of `deleteId`, which starts at 0, so the first call returns 1. */
  next(deleteId: string): number;
}

/** A counter for one request; a recursive delete shares it across every throwIn it makes. */
export function createTrashCounter(): TrashRequestCounter {
  const counts = new Map<string, number>();
  return {
    next(deleteId: string): number {
      const count = (counts.get(deleteId) ?? 0) + 1;
      counts.set(deleteId, count);
      return count;
    },
  };
}

/** muraDeleteDateTime and muraDeleteID of a throw-in. */
export interface DeleteMarkers {
  deletedDate: Date;
  deleteId: string;
}

/** The markers a recursive delete passes down, else `now` and a new createUUID() (trashManager.cfc:178-189). */
export function deleteMarkers(now: Date, shared: Partial<DeleteMarkers> = {}): DeleteMarkers {
  return {
    deletedDate: shared.deletedDate ?? now,
    deleteId: shared.deleteId !== undefined && shared.deleteId !== '' ? shared.deleteId : cfUuid(),
  };
}

// bean.setValue trims simple values, so the date reaches getAllValues() as its "{ts 'yyyy-mm-dd HH:nn:ss'}" text.
/** The two entries setValue adds to the deleted bean, in assignment order, for its getAllValues() struct. */
export function deleteMarkerAssignments(markers: DeleteMarkers): Array<[string, WddxValue]> {
  return [
    ['muraDeleteDateTime', `{ts '${cfDateTimeFormat(markers.deletedDate, 'yyyy-mm-dd HH:nn:ss')}'}`],
    ['muraDeleteID', markers.deleteId],
  ];
}

/** A simple bean value as a varchar param binds it. */
function simpleText(key: string, value: WddxValue): string {
  if (typeof value === 'string') return value;
  if (value instanceof WddxNumber) return value.text;
  throw new TypeError(`Trash value '${key}' is not a simple value`);
}

/** getDeletedParentID (trashManager.cfc:282-296): `deletedParentID`, else `parentID`, else 'NA'; the address branch is people's. */
export function deletedParentId(values: WddxStruct): string {
  for (const key of ['deletedParentID', 'parentID']) {
    const value = wddxStructGet(values, key);
    if (value !== undefined) return simpleText(key, value);
  }
  return 'NA';
}

// The Type 1/2 -> Group/User rename (trashManager.cfc:239-243) only applies to user beans, which people and identity own.
/** objectType (trashManager.cfc:233-237): the bean's `Type` when it holds one (content, feed), else its entity name. */
export function trashObjectType(values: WddxStruct, entityName: string): string {
  const type = wddxStructGet(values, 'Type');
  return type === undefined ? entityName : simpleText('Type', type);
}

/** objectSubType (trashManager.cfc:245-249): the bean's `subType` when it holds one, else 'Default'. */
export function trashObjectSubType(values: WddxStruct): string {
  const subType = wddxStructGet(values, 'subType');
  return subType === undefined ? 'Default' : simpleText('subType', subType);
}

// The insert binds muraDeleteDateTime's trimmed "{ts}" text, so legacy stores whole seconds.
/** `deletedDate` as legacy stores it. */
function wholeSeconds(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}

/**
 * throwIn inside the deleting operation's transaction: inserts the `content.trash` row of `entry` unless one exists for
 * its object id; returns the inserted row, or null when one existed.
 */
export async function throwIn(
  tx: TenantTx,
  repository: ContentRepository,
  entry: TrashEntry,
  actor: Actor,
  counter: TrashRequestCounter,
  write: WriteContext = writeContextFor(actor),
): Promise<TrashRow | null> {
  // Legacy counts every throw-in of the delete id before it checks for an existing row.
  const orderno = counter.next(entry.deleteId);
  return repository.trash.insertTrashIfAbsent(
    tx,
    {
      objectid: entry.objectId,
      parentid: entry.parentId,
      siteid: entry.siteId,
      objectclass: entry.objectClass,
      objectlabel: entry.label,
      objecttype: entry.objectType,
      objectsubtype: entry.objectSubType,
      objectstring: cfml2wddx(entry.values),
      deleteddate: wholeSeconds(entry.deletedDate),
      deletedby: actor.fullName.slice(0, 50),
      deleteid: entry.deleteId,
      orderno,
    },
    write,
  );
}

/** Parts of takeOut not reproduced: both run only for a bean restored from the trash, which only the withheld ctrash restore makes. */
export const TAKEOUT_UNBUILT = ['fileManager.restoreVersion', 'child restore'] as const;

// Legacy acts only when the saved bean holds `fromMuraTrash` (trashManager.cfc:417-419), which only ctrash's restore sets;
// ctrash stays on legacy (decision list), so no carried save reaches the purge.
/** takeOut of a saved content, change set or category; a no-op on every carried path, called to keep legacy's call order. */
export function takeOut(_values: WddxStruct | Record<string, unknown>): void {
  return;
}
