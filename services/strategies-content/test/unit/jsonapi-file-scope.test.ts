/** JSON API paths whose segment after the site id names ACF's `file` scope: legacy's invalidMethodCall, not the file entity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_JSON_CONTENT_TYPE, etag } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { buildTestApp, createRecordingDb, type TestApp } from '../helpers/app.js';
import { seedRecordingDb } from '../helpers/seed.js';
import { contentHeaders } from '../helpers/tokens.js';

const FILE_ID = 'F9FF3CA7-D449-FE65-77D6F45D5C34EC44';
const POOL = TENANT_UMBRELLA.siteId;

/** Legacy's bytes for a request whose path method is `method` (oracle: GET /_api/json/v1/umbrella/file/<id>). */
const invalidMethodCall = (method: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"message":"Invalid method call","code":"invalid_request"}}`;

let api: TestApp;

beforeAll(async () => {
  const db = createRecordingDb();
  seedRecordingDb(db);
  api = await buildTestApp({ db });
});

afterAll(async () => {
  await api?.close();
});

/** Headers of an anonymous call, or of the umbrella site's S2 admin. */
async function headersOf(caller: 'anonymous' | 'admin'): Promise<Record<string, string>> {
  return caller === 'anonymous' ? contentHeaders('anonymous') : contentHeaders('s2', { site: POOL });
}

describe('the file scope segment', () => {
  it.each(
    (
      [
        ['GET', `/_api/json/v1/${POOL}/file/${FILE_ID}`, 'file'],
        ['GET', `/_api/json/v1/${POOL}/file/new`, 'file'],
        ['GET', `/_api/json/v1/${POOL}/file`, 'file'],
        ['GET', `/_api/ajax/v1/${POOL}/File/${FILE_ID}`, 'File'],
        ['POST', `/_api/json/v1/${POOL}/file/`, 'file'],
      ] as const
    ).flatMap(([method, url, reported]) => (['anonymous', 'admin'] as const).map((caller) => ({ method, url, reported, caller }))),
  )("answers $method $url × $caller with legacy's 400 invalidMethodCall before any domain read", async ({ method, url, reported, caller }) => {
    api.db.clear();
    api.client.clear();
    const res = await api.app.inject({ method, url, headers: await headersOf(caller) });
    const body = invalidMethodCall(reported);
    expect([res.statusCode, res.headers['content-type'], res.body, res.headers.etag]).toEqual([400, LEGACY_JSON_CONTENT_TYPE, body, etag(body)]);
    expect(api.db.statements.filter((statement) => statement.tenantId !== null)).toEqual([]);
    expect(api.client.requests).toEqual([]);
  });

  it("keeps a site id that is not a variable name on the file entity route, as legacy does (oracle: anonymous 401 findOne)", async () => {
    const res = await api.app.inject({ method: 'GET', url: `/_api/json/v1/${TENANT_A.siteId}/file/${FILE_ID}`, headers: await headersOf('anonymous') });
    expect([res.statusCode, res.body]).toEqual([
      401,
      '{"apiversion":"v1","method":"findOne","error":{"message":"Insufficient Account Permissions","code":"invalid_request"}}',
    ]);
  });
});
