import { describe, expect, it } from 'vitest';
import {
  InvalidTenantIdError,
  SYSTEM_TENANT_ID,
  TENANT_NAMESPACE,
  assertTenantId,
  isTenantId,
  tenantIdForSite,
} from '../../src/tenancy/tenant-id.js';

const CF_UUID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

/** Returns what `fn` throws, failing the test when it returns normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('tenant id constants', () => {
  it('fixes the UUIDv5 namespace and uses the nil uuid as the system tenant', () => {
    expect(TENANT_NAMESPACE).toBe('6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c');
    expect(SYSTEM_TENANT_ID).toBe('00000000-0000-0000-0000-000000000000');
  });
});

describe('tenantIdForSite', () => {
  it.each([
    ['default', 'e6b84010-a5ea-5ceb-9c81-3a2cf616ff46'],
    ['tenant-a', 'edec963e-3516-5bb6-845d-d01a710e32a7'],
    ['tenant-b', '13ab03ed-8b4b-5174-b787-d32a11dd8793'],
    ['umbrella', '455225fe-8c2a-5c61-b33e-f9a8f2cac49a'],
  ])('maps site %s to %s', (siteId, expected) => {
    expect(tenantIdForSite(siteId)).toBe(expected);
  });

  it('case-folds the site id before deriving', () => {
    expect(tenantIdForSite('Tenant-A')).toBe(tenantIdForSite('tenant-a'));
    expect(tenantIdForSite('DEFAULT')).toBe('e6b84010-a5ea-5ceb-9c81-3a2cf616ff46');
  });

  it('returns a lower-case version 5 uuid that passes assertTenantId unchanged', () => {
    const tenantId = tenantIdForSite('tenant-a');
    expect(tenantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(assertTenantId(tenantId)).toBe(tenantId);
  });

  it('rejects an empty site id with a TypeError', () => {
    expect(() => tenantIdForSite('')).toThrow(TypeError);
    expect(() => tenantIdForSite('')).toThrow('siteId must be a non-empty string');
  });
});

describe('isTenantId', () => {
  it.each([
    ['a derived tenant id', tenantIdForSite('default')],
    ['an upper-case uuid', TENANT_NAMESPACE.toUpperCase()],
    ['the nil uuid', SYSTEM_TENANT_ID],
  ])('accepts %s', (_label, value) => {
    expect(isTenantId(value)).toBe(true);
  });

  it.each([
    ['a site id', 'default'],
    ['an empty string', ''],
    ['a CF 35-character id', CF_UUID],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', { tenantId: SYSTEM_TENANT_ID }],
  ])('rejects %s', (_label, value) => {
    expect(isTenantId(value)).toBe(false);
  });
});

describe('assertTenantId', () => {
  it.each([
    ['an upper-case uuid', 'EDEC963E-3516-5BB6-845D-D01A710E32A7', 'edec963e-3516-5bb6-845d-d01a710e32a7'],
    ['the nil uuid', SYSTEM_TENANT_ID, SYSTEM_TENANT_ID],
  ])('returns %s lower-cased', (_label, value, expected) => {
    expect(assertTenantId(value)).toBe(expected);
  });

  it.each([
    { label: 'a site id', value: 'default', message: 'Invalid tenant id: "default"' },
    { label: 'an empty string', value: '', message: 'Invalid tenant id: ""' },
    { label: 'a CF 35-character id', value: CF_UUID, message: `Invalid tenant id: "${CF_UUID}"` },
    { label: 'a string containing a quote', value: 'a"b', message: 'Invalid tenant id: "a\\"b"' },
    { label: 'a 64-character string', value: 'x'.repeat(64), message: `Invalid tenant id: "${'x'.repeat(64)}"` },
    { label: 'a 65-character string', value: 'x'.repeat(65), message: 'Invalid tenant id: string of length 65' },
    { label: 'null', value: null, message: 'Invalid tenant id: null' },
    { label: 'undefined', value: undefined, message: 'Invalid tenant id: undefined' },
    { label: 'a number', value: 42, message: 'Invalid tenant id: number' },
  ])('throws InvalidTenantIdError for $label', ({ value, message }) => {
    const error = thrownBy(() => assertTenantId(value));
    expect(error).toBeInstanceOf(InvalidTenantIdError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'InvalidTenantIdError', message });
    expect((error as InvalidTenantIdError).value).toBe(value);
  });
});
