/** JSON API operations no handler ports: each content entity's `validate` fails closed with the legacy 503. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { contentEntities } from '../../src/legacy/jsonapi-entities.js';
import { resolveJsonApiCall, type JsonApiResolveOptions } from '../../src/routes/jsonapi.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { contentHeaders } from '../helpers/tokens.js';

const SITE = TENANT_A.siteId;
const REGISTERED: ReadonlySet<string> = new Set([TENANT_A, TENANT_B, TENANT_UMBRELLA].map((tenant) => tenant.siteId));
const RESOLVE: JsonApiResolveOptions = {
  siteExists: (siteId) => REGISTERED.has(siteId.toLowerCase()),
  appReloadKey: 'appreload',
  context: '',
  variations: true,
};
const ENDPOINTS = { api: `/_api/json/v1/${SITE}`, rest: `/_api/rest/v1/${SITE}` } as const;
const FAMILIES = Object.keys(ENDPOINTS) as Array<keyof typeof ENDPOINTS>;

/** [route key, request URL, refusal reason] of every unported operation on both families. */
const UNPORTED: ReadonlyArray<readonly [string, string, string]> = FAMILIES.flatMap((family) => [
  ...contentEntities({ variations: true }).map((entity) => {
    const name = entity.name.toLowerCase();
    return [`${family}:${name}.validate`, `${ENDPOINTS[family]}/?method=validate&entityname=${entity.name}`, `jsonapi-${name}-validate-not-ported`] as const;
  }),
]);

function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));
}

let api: TestApp;

beforeAll(async () => {
  api = await buildTestApp({ env: { MURA_VARIATIONS: 'true' } });
});

afterAll(async () => {
  await api?.close();
});

describe('unported JSON API operations', () => {
  it.each(UNPORTED)('resolves %s, requested as %s, to its not-ported refusal', (key, url, reason) => {
    const resolved = resolveJsonApiCall({ method: 'GET', url, query: queryOf(url), body: undefined, headers: {} }, RESOLVE);
    expect(resolved.key.key).toBe(key);
    expect(resolved.target).toEqual({ kind: 'refused', reason });
  });

  it.each(UNPORTED)('answers %s with the legacy 503 before any tenant read', async (_key, url) => {
    api.db.clear();
    const res = await api.app.inject({ method: 'GET', url, headers: await contentHeaders('site-admin') });
    expect(res.statusCode).toBe(503);
    expect(api.db.statements.filter((statement) => statement.tenantId !== null)).toEqual([]);
  });
});
