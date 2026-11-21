/** The SQL Server failures of people's legacy statements, held to the legacy oracle's debug pages. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LegacyQueryFault } from '@opt2/platform/legacy-compat';
import {
  addressInsertFault,
  addressUpdateFault,
  tagInsertFault,
  userInsertFault,
  type AddressInsertInline,
  type AddressUpdateInline,
  type UserInsertInline,
} from '../../src/legacy/query-fault.js';

interface FixtureCase {
  name: string;
  statement: 'userInsert' | 'addressInsert' | 'addressUpdate' | 'tagInsert';
  inline?: Record<string, string>;
  values: Record<string, string>;
  expected: { sql: string; errorCode: string; detail: string };
}

// Oracle: onError's debug page of each failed cfquery on the legacy server [legacy: core/appcfc/onError_include.cfm:177-288].
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/legacy-query-faults.json', import.meta.url), 'utf8')) as {
  database: string;
  datasource: string;
  cases: FixtureCase[];
};
const ENV = { MURA_DATABASE: FIXTURE.database, MURA_DATASOURCE: FIXTURE.datasource };

function faultOf({ statement, inline, values }: FixtureCase): LegacyQueryFault | undefined {
  switch (statement) {
    case 'userInsert':
      return userInsertFault(inline as unknown as UserInsertInline, values, ENV);
    case 'addressInsert':
      return addressInsertFault(inline as unknown as AddressInsertInline, values, ENV);
    case 'addressUpdate':
      return addressUpdateFault(inline as unknown as AddressUpdateInline, values, ENV);
    case 'tagInsert':
      return tagInsertFault({ userid: values.userid ?? null, siteid: values.siteid ?? null, tag: values.tag ?? null }, ENV);
  }
}

describe('people query faults', () => {
  it.each(FIXTURE.cases.map((c) => [c.name, c] as const))('fails %s with the SQL, SQLSTATE and driver message of the legacy debug page', (_name, c) => {
    expect(faultOf(c)).toMatchObject({ message: 'Error Executing Database Query.', type: 'Database', ...c.expected });
  });
});
