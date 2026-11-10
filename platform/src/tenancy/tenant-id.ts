import { v5, validate } from 'uuid';

/** Fixed UUIDv5 namespace from which every tenant id is derived. */
export const TENANT_NAMESPACE = '6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c';

/** Nil UUID owning tenant-less rows of the local tasks adapter; never a site and never in tenant_registry. */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const MAX_ECHOED_LENGTH = 64;

/** UUIDv5 tenant id for a legacy siteID, case-folded to match SQL Server's case-insensitive site comparison. */
export function tenantIdForSite(siteId: string): string {
  if (siteId === '') {
    throw new TypeError('siteId must be a non-empty string');
  }
  return v5(siteId.toLowerCase(), TENANT_NAMESPACE);
}

/** Raised when a value is not a UUID tenant id; `value` holds the rejected input. */
export class InvalidTenantIdError extends Error {
  override readonly name = 'InvalidTenantIdError';
  readonly value: unknown;

  constructor(value: unknown) {
    super(`Invalid tenant id: ${describeValue(value)}`);
    this.value = value;
  }
}

function describeValue(value: unknown): string {
  if (typeof value !== 'string') {
    return value === null ? 'null' : typeof value;
  }
  return value.length <= MAX_ECHOED_LENGTH ? JSON.stringify(value) : `string of length ${String(value.length)}`;
}

/** True when the value is a UUID string of any version, the nil UUID included. */
export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && validate(value);
}

/** Returns the tenant id lower-cased, or throws InvalidTenantIdError when it is not a UUID. */
export function assertTenantId(value: unknown): string {
  if (!isTenantId(value)) {
    throw new InvalidTenantIdError(value);
  }
  return value.toLowerCase();
}
