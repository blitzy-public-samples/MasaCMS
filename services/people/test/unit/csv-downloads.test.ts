/** The cUsers CSV column headers and the downloads' cUsers gate; the CSV bodies over PostgreSQL are in test/isolation/csv-downloads.test.ts. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfListQualifyChar } from '@opt2/platform/legacy-compat';
import { TENANT_A } from '@opt2/platform/testing';
import { SEARCH_FIELD_LIST, USERS_LIST_COLUMNS } from '../../src/domain/search.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { DOWNLOAD_SEARCH, DOWNLOAD_USERS, SEARCH_HEADER, USERS_HEADER, call } from '../helpers/csv-downloads.js';
import { MODULE_008_ONLY } from '../helpers/fixtures.js';

describe('users CSV column header', () => {
  it.each<[query: string, columns: readonly string[], header: string]>([
    ['getUsers', USERS_LIST_COLUMNS, USERS_HEADER],
    ['getAdvancedSearch', SEARCH_FIELD_LIST, SEARCH_HEADER],
  ])('lists the %s columns as ACF columnList does: upper-cased, sorted, quoted', (_query, columns, header) => {
    const columnList = columns.map((column) => column.toUpperCase()).sort();
    expect(header).toBe(`${cfListQualifyChar(columnList.join(','))}\n`);
  });
});

describe('the cUsers gate on the downloads', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp();
  });

  afterAll(async () => {
    await testApp?.close();
  });

  it.each([DOWNLOAD_USERS, DOWNLOAD_SEARCH])('answers the Users module alone the noaccess denial and no CSV on %s', async (path) => {
    testApp.db.clear();
    const res = await call(testApp.app, 'GET', `${path}?siteid=${TENANT_A.siteId}&ispublic=0`, MODULE_008_ONLY);
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(JSON.parse(res.body)).toMatchObject({ error: { message: 'Insufficient Account Permissions' } });
    expect(testApp.db.statements()).toEqual([]);
    expect(testApp.identity.requests).toEqual([]);
  });
});
