/** Address save fixtures shared by the offline and PostgreSQL address-domain suites. */
import { withGatedTenant } from '@opt2/platform/migration-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, fixedClock } from '@opt2/platform/testing';
import { ADDRESS_DEFAULTS, applyAddressInput, createAddress, type AddressActor, type AddressDeps, type AddressValues } from '../../src/domain/addresses.js';
import type { PersonFence } from '../../src/domain/person-fence.js';
import { normaliseParams } from '../../src/domain/person.js';
import type { PeopleRepository } from '../../src/repo/repository.js';

export const CLOCK = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
export const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
export const USER_ID_REQUIRED = "The attribute 'USERID' is required when saving an address.";
export const ACTOR_A: AddressActor = { tid: TENANT_A.tenantId, write: { actorUserId: 'ACTOR', requestId: 'REQ-1' } };

export type AddressSave = typeof createAddress;

/** A fresh bean with posted `params` set. */
export function bean(params: Record<string, unknown>, poolSite?: string): AddressValues {
  return applyAddressInput({ ...ADDRESS_DEFAULTS, errors: {} }, normaliseParams(params), poolSite);
}

/** The error `outcome` rejects with. */
export async function rejection(outcome: Promise<unknown>): Promise<unknown> {
  try {
    await outcome;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/** Save collaborators whose fence records each `fencePersons` call as its tenant and ids, then resolves or rejects with `refusal`. */
export function harness(db: TenantDb, repo: PeopleRepository, refusal?: Error): { deps: AddressDeps; fenced: string[][] } {
  const fenced: string[][] = [];
  const fence: PersonFence = {
    fencePersons: (tx, userIds) => {
      fenced.push([tx.tenantId, ...userIds]);
      return refusal === undefined ? Promise.resolve() : Promise.reject(refusal);
    },
    withPersonsOpen: (fenceDb, tenantId, fn, opts) =>
      fenceDb !== db || opts.clock !== CLOCK ? Promise.reject(new Error('withPersonsOpen got foreign collaborators')) : withGatedTenant(fenceDb, tenantId, fn),
  };
  return { deps: { db, repo, clock: CLOCK, fence }, fenced };
}
