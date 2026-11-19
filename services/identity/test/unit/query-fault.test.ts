/** The SQL Server failures of identity's legacy statements, held to the legacy oracle's debug pages. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LegacyQueryFault } from '@opt2/platform/legacy-compat';
import {
  addressInsertFault,
  addressUpdateFault,
  permissionInsertFault,
  permissionKeyFault,
  tagInsertFault,
  userInsertFault,
  userUpdateFault,
  type AddressInsertInline,
  type AddressUpdateInline,
  type UserInline,
  type UserUpdateInline,
} from '../../src/legacy/query-fault.js';

interface FixtureCase {
  name: string;
  statement: 'userInsert' | 'userUpdate' | 'addressInsert' | 'tagInsert' | 'permissionInsert' | 'permissionKey';
  inline?: Record<string, string>;
  values: Record<string, string>;
  withPassword?: boolean;
  expected: { sql: string; errorCode: string; detail: string };
}

// Oracle: onError's debug page of each failed cfquery on the legacy server [legacy: core/appcfc/onError_include.cfm:177-288].
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/legacy-query-faults.json', import.meta.url), 'utf8')) as {
  database: string;
  datasource: string;
  cases: FixtureCase[];
};
const ENV = { MURA_DATABASE: FIXTURE.database, MURA_DATASOURCE: FIXTURE.datasource };

function permissionRow(values: Record<string, string>): { contentid: string; groupid: string; siteid: string } {
  return { contentid: values.contentid ?? '', groupid: values.groupid ?? '', siteid: values.siteid ?? '' };
}

function faultOf({ statement, inline, values, withPassword }: FixtureCase): LegacyQueryFault | undefined {
  switch (statement) {
    case 'userInsert':
      return userInsertFault(inline as unknown as UserInline, values, ENV);
    case 'userUpdate':
      return userUpdateFault(inline as unknown as UserUpdateInline, withPassword === true, values, ENV);
    case 'addressInsert':
      return addressInsertFault(inline as unknown as AddressInsertInline, values, ENV);
    case 'tagInsert':
      return tagInsertFault({ userid: values.userid ?? null, siteid: values.siteid ?? null, tag: values.tag ?? null }, ENV);
    case 'permissionInsert':
      return permissionInsertFault(permissionRow(values), ENV);
    case 'permissionKey':
      return permissionKeyFault(permissionRow(values));
  }
}

describe('identity query faults', () => {
  it.each(FIXTURE.cases.map((c) => [c.name, c] as const))('fails %s with the SQL, SQLSTATE and driver message of the legacy debug page', (_name, c) => {
    expect(faultOf(c)).toMatchObject({ message: 'Error Executing Database Query.', type: 'Database', ...c.expected });
  });

  it('fails the UPDATE of a stored group address on the first value its column cannot hold, in SET order', () => {
    const inline: AddressUpdateInline = { siteid: 'default', longitude: '0', latitude: '0' };
    const fault = addressUpdateFault(inline, { addressid: 'A', userid: 'U', siteid: 'default', fax: 'f'.repeat(51), city: 'c'.repeat(51) }, ENV);
    expect(fault).toMatchObject({ errorCode: 'HY000' });
    expect(fault?.detail).toContain(`table '${FIXTURE.database}.dbo.tuseraddresses', column 'city'.`);
    expect(fault?.sql).toMatch(/^UPDATE tuseraddresses SET/);
    expect(addressUpdateFault(inline, { addressid: 'A', userid: 'U', siteid: 'default', city: 'c'.repeat(50) }, ENV)).toBeUndefined();
  });

  it('fits a group whose values its columns hold', () => {
    const inline: UserInline = { userid: 'U', s2: '0', type: '1', inactive: '0', perm: '1.5', ispublic: '1', subscribe: '1', keepprivate: '0' };
    expect(userInsertFault(inline, { userid: 'U', groupname: 'g'.repeat(255), siteid: 'default' }, ENV)).toBeUndefined();
  });
});
