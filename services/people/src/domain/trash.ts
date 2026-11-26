// Masa trashManager throwIn and takeOut (trashManager.cfc:155-290, 406-446) for people's share of ttrash: the
// `address` class of Type=2 users' addresses, plus the `takeOut` of an address or user restored from the trash.
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { cfUuid, javaTrim } from '@opt2/platform/legacy-compat';
import { addressTrashValues, cfml2wddx, type AddressRow as LegacyAddressRow } from '../legacy/wddx.js';
import type { PeopleRepository, TrashInput } from '../repo/repository.js';
import { TRASH, type AddressRow, type TrashRow } from '../repo/tables.js';
import type { ExtendSetData } from './extended-data.js';

/** People holds the `people.trash` unit, so its trash writes run here. */
export const PEOPLE_TRASH_ENABLED = true;

/** The acting session user `$.currentUser('fullname')` names; `fullName` is '' when anonymous. */
export interface TrashActor {
  fullName: string;
}

/** The per-request `request["delete#hash(deleteID)#"]` counter that numbers throw-ins sharing a delete id; one per request. */
export class TrashRequestCounter {
  private readonly counts = new Map<string, number>();

  /** Increments and returns the count of `deleteId`, which starts at 0, so the first call returns 1. */
  next(deleteId: string): number {
    const count = (this.counts.get(deleteId) ?? 0) + 1;
    this.counts.set(deleteId, count);
    return count;
  }
}

/** Parts of takeOut not reproduced: they restore strategies-content `tfiles` versions or re-save other entities. */
export const TAKEOUT_UNBUILT = ['fileManager.restoreVersion', 'restore of child trash items'] as const;

// The stored row, not user-entity's AddressValues, is the input: userDAO.readAddress builds the deleted bean from it.
/** A stored address as `userDAO.readAddress` loads it, with the bean's delete markers and instance id when a caller holds them. */
export type TrashedAddress = Omit<AddressRow, 'tenant_id'> & {
  muradeletedatetime?: Date;
  muradeleteid?: string;
  instanceid?: string;
};

/** Collaborators of `throwInAddress`; `extend` is getAllExtendSetData of the address. */
export interface ThrowInContext {
  actor: TrashActor;
  clock: Clock;
  counter: TrashRequestCounter;
  write: WriteContext;
  extend: Pick<ExtendSetData, 'entries' | 'extendSetId'>;
}

/** A stored column as `bean.set(rs)` holds it: trimmed, NULL as ''. */
function beanText(value: string | null): string {
  return javaTrim(value ?? '');
}

/** The stored row in the legacy column names the WDDX struct is built from. */
function legacyAddressRow(address: TrashedAddress): LegacyAddressRow {
  return {
    addressID: address.addressid,
    userID: address.userid,
    siteID: address.siteid,
    addressName: address.addressname,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country,
    phone: address.phone,
    fax: address.fax,
    isPrimary: address.isprimary,
    addressNotes: address.addressnotes,
    addressURL: address.addressurl,
    longitude: address.longitude,
    latitude: address.latitude,
    addressEmail: address.addressemail,
    hours: address.hours,
  };
}

// setValue trims the date to its "{ts 'yyyy-mm-dd HH:nn:ss'}" text before the insert binds it, so legacy stores whole seconds.
/** `deletedDate` as legacy stores the muraDeleteDateTime it inserted. */
function wholeSeconds(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}

/**
 * throwIn of a stored address before its delete (userManager.cfc:939-947): inserts its `people.trash` row unless one
 * exists for the address id; returns the inserted row, or null when one existed.
 */
export async function throwInAddress(
  repo: PeopleRepository,
  tx: TenantTx,
  address: TrashedAddress,
  ctx: ThrowInContext,
): Promise<TrashRow | null> {
  const deletedAt = address.muradeletedatetime ?? ctx.clock.now();
  const deleteId = address.muradeleteid !== undefined && address.muradeleteid !== '' ? address.muradeleteid : cfUuid();
  // Legacy counts every throw-in of the delete id before it checks for an existing row.
  const orderno = ctx.counter.next(deleteId);
  const objectString = cfml2wddx(
    addressTrashValues({
      address: legacyAddressRow(address),
      extendedData: { extendSetId: ctx.extend.extendSetId, data: ctx.extend.entries },
      deleteDateTime: deletedAt,
      deleteId,
      instanceId: address.instanceid ?? cfUuid(),
    }),
  );
  const row: TrashInput = {
    objectid: beanText(address.addressid),
    parentid: beanText(address.userid),
    siteid: beanText(address.siteid),
    objectlabel: beanText(address.addressname),
    objectclass: 'address',
    objecttype: 'Address',
    objectsubtype: 'Default',
    objectstring: objectString,
    deleteddate: wholeSeconds(deletedAt),
    deletedby: ctx.actor.fullName.slice(0, 50),
    deleteid: deleteId,
    orderno,
  };
  return repo.insertTrashIfAbsent(tx, row, ctx.write);
}

/**
 * takeOut of a saved address or user (userManager.cfc:658, 893): only when its values hold `frommuratrash`, deletes the
 * `people.trash` row of `objectId`; files and child items stay unrestored (TAKEOUT_UNBUILT). Returns whether a row was deleted.
 */
export async function takeOut(
  repo: PeopleRepository,
  tx: TenantTx,
  objectId: string,
  values: ReadonlyMap<string, unknown>,
  ctx: { write: WriteContext },
): Promise<boolean> {
  if (!values.has('frommuratrash')) return false;
  return (await repo.delete(tx, TRASH.table, { objectid: objectId }, ctx.write)) !== null;
}
