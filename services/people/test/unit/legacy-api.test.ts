/** People's Masa JSON API `user` and `address` routes through `buildTestApp` and `app.inject` over the recording database: wire format, route ownership and denials, address findMany batching; and the iterator page hold. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LegacyApiError, SCAN_HALT_VARIANT, WWW_AUTHENTICATE, isCfUuid, scannedRouteKey } from '@opt2/platform/legacy-compat';
import { ROLE_SET, TENANT_A, TENANT_B, TENANT_UMBRELLA, fixtureForSite, registryPayloads, type RoleSubject } from '@opt2/platform/testing';
import type { AddressRow, ExtendAttributeRow, ExtendDataRow } from '../../src/repo/tables.js';
import { iteratorPage, iteratorPageHold } from '../../src/routes/legacy-api.js';
import {
  buildTestApp,
  headersFor,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';
import {
  ADMIN_S2,
  DEFAULT_PEOPLE_SEED,
  OTHER_TENANT,
  SITE_ADMIN_A,
  SYSTEM_USER_A,
  accountsForSeed,
  addressRow,
  extendAttributeRow,
  extendDataRow,
} from '../helpers/fixtures.js';
import {
  CSRF,
  FAMILIES,
  RELOAD_KEY,
  actorHeaders,
  apiPath,
  dataOf,
  legacyEnvelope,
  legacyError,
  send,
  type InjectedResponse,
  type Method,
} from '../helpers/legacy-api-wire.js';
import { UNEXPECTED_DB_FAILURES, captureRequestLogs, expectSerializedErrorLog } from '../helpers/request-logs.js';

/** The gateway's invocation credential alone: an anonymous browser request. */
function anonymousHeaders(): Promise<Record<string, string>> {
  const gateway: RoleSubject | undefined = ROLE_SET.find((subject) => subject.kind === 'service' && subject.caller === 'gateway');
  if (gateway === undefined) throw new Error('ROLE_SET has no gateway subject');
  return headersFor(gateway);
}

/** One injected multipart request: text fields, then a file part. */
async function sendMultipart(
  app: TestApp['app'],
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  file: { field: string; filename: string; type: string; content: string },
): Promise<InjectedResponse> {
  const boundary = 'opt2-legacy-api-boundary';
  const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n${file.content}\r\n`);
  return app.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `${parts.join('')}--${boundary}--\r\n`,
  });
}

/** The fixture registry as `tenant_registry` rows, ordered by site id. */
function registryRows(): Array<Record<string, unknown>> {
  const tenantOf = (siteId: string | null | undefined): string | null =>
    siteId === null || siteId === undefined || siteId === '' ? null : (fixtureForSite(siteId)?.tenantId ?? null);
  return registryPayloads()
    .map((site) => {
      const content = Array.isArray(site.contentPoolIds) ? site.contentPoolIds : [];
      return {
        site_id: site.siteId,
        tenant_id: tenantOf(site.siteId),
        public_user_pool_id: site.publicUserPoolId ?? null,
        private_user_pool_id: site.privateUserPoolId ?? null,
        category_pool_id: site.categoryPoolId ?? null,
        file_pool_id: site.filePoolId ?? null,
        display_pool_id: site.displayPoolId ?? null,
        content_pool_ids: content,
        public_user_pool_tenant: tenantOf(site.publicUserPoolId),
        private_user_pool_tenant: tenantOf(site.privateUserPoolId),
        category_pool_tenant: tenantOf(site.categoryPoolId),
        file_pool_tenant: tenantOf(site.filePoolId),
        display_pool_tenant: tenantOf(site.displayPoolId),
        content_pool_tenants: content.map(tenantOf),
        domains: site.domains ?? [],
        aggregate_version: '1',
        updated_at: new Date(2026, 5, 30, 12),
      };
    })
    .sort((a, b) => (a.site_id < b.site_id ? -1 : a.site_id > b.site_id ? 1 : 0));
}

/** Answers registry reads of a recording database from the fixture registry. */
function respondWithRegistry(db: RecordingDb): void {
  const rows = registryRows();
  db.respond(/\bFROM \S*tenant_registry\b/i, (text, values) => {
    if (/WHERE tenant_id = \$1/i.test(text)) return rows.filter((row) => row.tenant_id === values[0]);
    if (/WHERE lower\(site_id\) = lower\(\$1\)/i.test(text)) return rows.filter((row) => String(row.site_id).toLowerCase() === String(values[0]).toLowerCase());
    return rows;
  });
}

describe('JSON API wire format, ownership and denials over the recording database', () => {
  let testApp: TestApp;
  const seededAccounts = accountsForSeed(DEFAULT_PEOPLE_SEED);
  const target = SYSTEM_USER_A.sub;

  beforeAll(async () => {
    testApp = await buildTestApp();
    respondWithRegistry(testApp.db);
  });

  afterAll(async () => {
    await testApp?.close();
  });

  beforeEach(() => {
    testApp.identity.clear();
    testApp.identity.seedAccounts(...seededAccounts);
    testApp.db.clear();
  });

  /** Asserts that nothing reached identity and no row was written. */
  function expectUntouched(): void {
    expect(testApp.identity.requests).toEqual([]);
    expect(testApp.identity.operations.size).toBe(0);
    expect(testApp.db.writes()).toEqual([]);
  }

  describe.each(FAMILIES)('%s mode', (family) => {
    it('answers findNew of a user with new-bean defaults and a fresh CF UUID', async () => {
      const res = await send(testApp.app, 'GET', apiPath(family, '/user/new'), await actorHeaders(SITE_ADMIN_A));
      const envelope = legacyEnvelope(res, 200);
      expect(envelope.method).toBe('findNew');
      const data = envelope.data ?? {};
      expect(data).toMatchObject({ entityname: 'user', isnew: 1, siteid: TENANT_A.siteId, ispublic: 1, s2: 0 });
      expect(isCfUuid(String(data.id))).toBe(true);
      expect(data.userid).toBe(data.id);
      expect(data).not.toHaveProperty('password');
      expect((data.links as Record<string, string>).self).toContain(`/_api/json/v1/${TENANT_A.siteId}/user/${String(data.id)}`);
    });

    it('answers findNew of an address with its bean defaults', async () => {
      const data = dataOf(await send(testApp.app, 'GET', apiPath(family, '/address/new'), await actorHeaders(SITE_ADMIN_A)));
      expect(data).toMatchObject({ entityname: 'address', siteid: TENANT_A.siteId, userid: '' });
      expect(isCfUuid(String(data.addressid))).toBe(true);
      expect(data.id).toBe(data.addressid);
    });

    it('answers pollState anonymously', async () => {
      const envelope = legacyEnvelope(await send(testApp.app, 'GET', apiPath(family, '/user/pollState'), await anonymousHeaders()), 200);
      expect(envelope).toMatchObject({ method: 'pollState', data: { loggedin: false } });
    });

    it.each([
      ['anonymous', undefined],
      ['a system user without the Users module', SYSTEM_USER_A],
    ])('refuses findOne to %s with the authorization envelope', async (_name, actor) => {
      const headers = actor === undefined ? await anonymousHeaders() : await actorHeaders(actor);
      const envelope = legacyError(await send(testApp.app, 'GET', apiPath(family, `/user/${SITE_ADMIN_A.sub}`), headers), 'authorization');
      expect(envelope.method).toBe('findOne');
      expect(testApp.identity.requests).toEqual([]);
    });

    it.each([
      ['an administrator of another tenant', OTHER_TENANT],
      ['the super user of site default', ADMIN_S2],
    ])('refuses %s on a tenant-a path with 403', async (_name, actor) => {
      legacyError(await send(testApp.app, 'GET', apiPath(family, `/user/${target}`), await actorHeaders(actor)), 'authorization', 403);
      expectUntouched();
    });

    it.each([
      ['the API site', (path: string) => path.replace(`/${TENANT_A.siteId}/`, `/${TENANT_B.siteId}/`), undefined],
      ['a url siteid', (path: string) => `${path}?siteid=${TENANT_B.siteId}`, undefined],
      ['a form siteid', (path: string) => path, { siteid: TENANT_B.siteId, fname: 'Nobody' }],
    ])('refuses a siteid other than the token site named by %s with 403', async (_name, rewrite, form) => {
      const method: Method = form === undefined ? 'GET' : 'POST';
      const res = await send(testApp.app, method, rewrite(apiPath(family, `/user/${target}`)), { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF }, form);
      legacyError(res, 'authorization', 403);
      expectUntouched();
    });

    it.each([
      ['a content findOne', 'GET', `/content/${target}`],
      ['a site findOne', 'GET', `/site/${TENANT_A.siteId}`],
      ['a reload, the url as sent carrying its key', 'GET', `/user/new?${RELOAD_KEY}`],
    ] as const)('answers %s, a key people does not own, with the legacy 404 envelope', async (_name, method, rest) => {
      legacyError(await send(testApp.app, method, apiPath(family, rest), await actorHeaders(SITE_ADMIN_A)), 'invalidMethodCall', 404);
      expectUntouched();
    });

    // Deletes are withheld on the decision list and stay on legacy: people answers the legacy 503, never executes them.
    it.each([
      ['a user delete', `/user/${target}`],
      ['an address delete', `/address/${target}`],
    ] as const)('withholds %s with the legacy 503 before anything runs', async (_name, rest) => {
      const headers = { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF };
      legacyError(await send(testApp.app, 'DELETE', apiPath(family, rest), headers), 'server_error', 503);
      expectUntouched();
    });

    // Names the scan strips to one name with differing values leave the outcome to ColdFusion, so legacy serves the key.
    it.each(['user', 'address'] as const)('withholds a scan-halted %s findOne with the legacy 503 before any person read', async (entity) => {
      const url = apiPath(family, `/${entity}/${target}?a-b=probe&a.b=other`);
      const [path = '', search = ''] = url.split('?');
      const keyed = scannedRouteKey({ method: 'GET', path, url, query: Object.fromEntries(new URLSearchParams(search)), headers: {} });
      expect(keyed.result).toMatchObject({ key: `api:${entity}.findone{${SCAN_HALT_VARIANT}}`, variant: SCAN_HALT_VARIANT });

      legacyError(await send(testApp.app, 'GET', url, await actorHeaders(SITE_ADMIN_A)), 'server_error', 503);
      expectUntouched();
      expect(testApp.db.statements().filter(({ text }) => /\bFROM\b/i.test(text) && !/\btenant_registry\b/i.test(text))).toEqual([]);
    });

    it('withholds a multipart save uploading a photo with the legacy 503', async () => {
      const headers = { ...(await actorHeaders(SITE_ADMIN_A)), ...CSRF };
      const file = { field: 'newFile', filename: 'portrait.jpg', type: 'image/jpeg', content: 'JPEG' };
      legacyError(await sendMultipart(testApp.app, apiPath(family, `/user/${target}`), headers, { fname: 'Photo' }, file), 'server_error', 503);
      expectUntouched();
    });
  });

  describe('json mode details', () => {
    it.each([
      ['X-Forwarded-Proto', { 'x-forwarded-proto': 'https' }],
      ['Front-End-Https', { 'front-end-https': 'true' }],
    ])('builds entity links from the forwarded host and the %s scheme', async (_name, scheme) => {
      const headers = { ...(await actorHeaders(SITE_ADMIN_A)), 'x-forwarded-host': 'www.tenant-a.opt2.test:8443', ...scheme };
      const data = dataOf(await send(testApp.app, 'GET', apiPath('json', '/user/new'), headers));
      const { self } = data.links as { self: string };
      expect(self.startsWith('https://www.tenant-a.opt2.test')).toBe(true);
      expect(self).toContain(`/index.cfm/_api/json/v1/${TENANT_A.siteId}/user/${String(data.id)}`);
    });

    it('reads a findOne without an id as a new bean', async () => {
      const envelope = legacyEnvelope(await send(testApp.app, 'GET', apiPath('json', '?method=findOne&entityname=user'), await actorHeaders(SITE_ADMIN_A)), 200);
      expect(envelope).toMatchObject({ method: 'findOne', data: { entityname: 'user', isnew: 1, siteid: TENANT_A.siteId } });
    });

    it('answers an unregistered url siteid with invalidParameters, as legacy resolves the site from it', async () => {
      legacyError(await send(testApp.app, 'GET', apiPath('json', '/user/new?siteid=no-such-site'), await actorHeaders(SITE_ADMIN_A)), 'invalidParameters');
      expectUntouched();
    });

    it('validates a bean without rules as having no errors', async () => {
      const url = apiPath('json', `?method=validate&entityname=user&data=${encodeURIComponent('{"bean":"user"}')}`);
      expect(legacyEnvelope(await send(testApp.app, 'GET', url, await actorHeaders(SITE_ADMIN_A)), 200)).toMatchObject({ method: 'validate', data: {} });
      expectUntouched();
    });

    it('answers findProperties through the method form, the table hidden from an anonymous caller', async () => {
      const url = apiPath('json', '?method=findProperties&entityname=address&properties=city,zip');
      const envelope = legacyEnvelope(await send(testApp.app, 'GET', url, await anonymousHeaders()), 200);
      expect(envelope.method).toBe('findProperties');
      expect(envelope.data).toMatchObject({ entityname: 'address', primarykey: 'addressid' });
      expect(envelope.data).not.toHaveProperty('table');
      expect((envelope.data?.properties as Array<{ name: string }>).map((property) => property.name)).toEqual(['city', 'zip']);
    });

    it('denies an anonymous caller every permission through the method form', async () => {
      const url = apiPath('json', `?method=findPermissions&entityname=user&id=${target}`);
      const envelope = legacyEnvelope(await send(testApp.app, 'GET', url, await anonymousHeaders()), 200);
      expect(envelope).toMatchObject({ method: 'findPermissions', data: { read: false, delete: false, save: false } });
    });

    it.each([
      ['ad-hoc validation rules, which build a generic bean', '{}', '{"email":{"required":true}}', 'server_error', 503],
      ['a loadby validation of a stored property', '{"bean":"user","loadby":"email"}', undefined, 'server_error', 503],
      ['a loadby of a reserved argument', '{"bean":"user","loadby":"orderby"}', undefined, 'invalidParameters', 400],
      ['a complex siteid', '{"siteid":{"site":"tenant-a"}}', undefined, 'server_error', 500],
    ] as const)('answers validate of %s as legacy does', async (_name, data, validations, type, status) => {
      const rules = validations === undefined ? '' : `&validations=${encodeURIComponent(validations)}`;
      const url = apiPath('json', `?method=validate&entityname=user&data=${encodeURIComponent(data)}${rules}`);
      legacyError(await send(testApp.app, 'GET', url, await actorHeaders(SITE_ADMIN_A)), type, status);
      expectUntouched();
    });
  });

  describe('rest mode', () => {
    it('asks an anonymous caller for Basic credentials', async () => {
      const res = await send(testApp.app, 'GET', apiPath('rest', `/user/${target}`), await anonymousHeaders());
      legacyError(res, 'authorization');
      expect(res.headers['www-authenticate']).toBe(WWW_AUTHENTICATE.basic);
    });
  });
});

/** Whether two char ids are equal as SQL Server compares them: case-insensitively, trailing spaces ignored. */
function sameId(a: unknown, b: unknown): boolean {
  return String(a).trimEnd().toUpperCase() === String(b).trimEnd().toUpperCase();
}

/** The rows of `store`'s tenant `values[0]` whose `column` matches the id or ids `values[1]`; a request-position read answers each requested id's rows under its position. */
function requestedRows(store: ReadonlyMap<string, readonly Record<string, unknown>[]>, column: string, text: string, values: readonly unknown[]): Record<string, unknown>[] {
  const rows = store.get(String(values[0])) ?? [];
  const requested = values[1];
  if (!Array.isArray(requested)) return rows.filter((row) => sameId(row[column], requested));
  if (!text.includes('request_position')) return rows.filter((row) => requested.some((id) => sameId(row[column], id)));
  return requested.flatMap((id, index) => rows.filter((row) => sameId(row[column], id)).map((row) => ({ request_position: index + 1, ...row })));
}

describe('address findMany over the recording database', () => {
  const ids = {
    pooled: 'A1000000-0000-0000-0000000000000000',
    home: 'B2000000-0000-0000-0000000000000000',
    both: 'C3000000-0000-0000-0000000000000000',
    work: 'D4000000-0000-0000-0000000000000000',
    elsewhere: 'E5000000-0000-0000-0000000000000000',
    umbrellaSite: 'F6000000-0000-0000-0000000000000000',
  } as const;
  type Name = keyof typeof ids;
  const owner = SYSTEM_USER_A.sub;
  const umbrella = TENANT_UMBRELLA.tenantId;
  /** tenant-a's own addresses and its public pool's in umbrella, where a second `both` names another city. */
  const ADDRESSES: ReadonlyMap<string, readonly AddressRow[]> = new Map([
    [
      TENANT_A.tenantId,
      [
        addressRow({ addressid: ids.home, userid: owner, city: 'Home' }),
        addressRow({ addressid: ids.both, userid: owner, city: 'Own' }),
        addressRow({ addressid: ids.work, userid: owner, city: 'Work' }),
        addressRow({ addressid: ids.elsewhere, userid: owner, siteid: TENANT_B.siteId, city: 'Elsewhere' }),
      ],
    ],
    [
      umbrella,
      [
        addressRow({ tenant_id: umbrella, addressid: ids.pooled, city: 'Pooled' }),
        addressRow({ tenant_id: umbrella, addressid: ids.both, city: 'Pool' }),
        addressRow({ tenant_id: umbrella, addressid: ids.umbrellaSite, siteid: TENANT_UMBRELLA.siteId, city: 'Umbrella' }),
      ],
    ],
  ]);
  const EXTEND_DATA: ReadonlyMap<string, readonly ExtendDataRow[]> = new Map([
    [TENANT_A.tenantId, [extendDataRow({ baseid: ids.home, attributeid: 7, attributevalue: 'North' })]],
    [umbrella, [extendDataRow({ tenant_id: umbrella, baseid: ids.pooled, attributeid: 8, attributevalue: '3' })]],
  ]);
  const ATTRIBUTES: ReadonlyMap<string, readonly ExtendAttributeRow[]> = new Map([
    [TENANT_A.tenantId, [extendAttributeRow({ attributeid: 7, name: 'gate' })]],
    [umbrella, [extendAttributeRow({ tenant_id: umbrella, attributeid: 8, name: 'floor' })]],
  ]);
  /** Each address item's stored city and extended values, `both` as tenant-a holds it. */
  const ITEMS: Readonly<Record<Name, Record<string, unknown>>> = {
    pooled: { addressid: ids.pooled, city: 'Pooled', floor: '3' },
    home: { addressid: ids.home, city: 'Home', gate: 'North' },
    both: { addressid: ids.both, city: 'Own' },
    work: { addressid: ids.work, city: 'Work' },
    elsewhere: { addressid: ids.elsewhere, city: 'Elsewhere' },
    umbrellaSite: { addressid: ids.umbrellaSite, city: 'Umbrella' },
  };
  const MISSING = '0F000000-0000-0000-0000000000000000';
  /** Every id in an order unlike the addressid order, one in another case and one repeated. */
  const REQUESTED = [ids.work, ids.pooled, ids.elsewhere, ids.both.toLowerCase(), ids.home, ids.umbrellaSite, ids.work];
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp();
    respondWithRegistry(testApp.db);
    testApp.db.respond(/"user_address"/, (text, values) => requestedRows(ADDRESSES, 'addressid', text, values));
    testApp.db.respond(/"extend_data_user_activity"/, (text, values) => requestedRows(EXTEND_DATA, 'baseid', text, values));
    testApp.db.respond(/"extend_attribute"/, (_text, values) =>
      (ATTRIBUTES.get(String(values[0])) ?? []).filter((row) => Array.isArray(values[2]) && values[2].includes(row.attributeid)),
    );
  });

  afterAll(async () => {
    await testApp?.close();
  });

  beforeEach(() => {
    testApp.db.clear();
  });

  /** findMany of the addresses `requested`, then `query`, for tenant-a's site administrator. */
  async function findMany(requested: readonly string[], query = ''): Promise<InjectedResponse> {
    return send(testApp.app, 'GET', apiPath('json', `?method=findMany&entityname=address&ids=${requested.join(',')}${query}`), await actorHeaders(SITE_ADMIN_A));
  }

  /** The tenant and requested ids of each recorded read of `table`. */
  function readsOf(table: string): Array<[unknown, unknown]> {
    return testApp.db.statements().flatMap((statement) => (statement.text.includes(`"${table}"`) ? [[statement.values[0], statement.values[1]] as [unknown, unknown]] : []));
  }

  it.each<[string, string, Name[], Record<string, number>]>([
    ['every address of the site in the order of the ids, a repeated id twice', '', ['work', 'pooled', 'both', 'home', 'work'], { totalitems: 4, totalpages: 1, pageindex: 1 }],
    ['a page of the addressid order in the order of the ids', '&itemsPerPage=2&pageIndex=2', ['work', 'both', 'work'], { totalitems: 4, totalpages: 2, pageindex: 2, itemsperpage: 2 }],
    ['the first limit rows of the addressid order', '&limit=3', ['pooled', 'both', 'home'], { totalitems: 3, totalpages: 1, pageindex: 1 }],
    ['the first row of a page size 1 under a limit', '&itemsPerPage=1&limit=3', ['pooled'], { totalitems: 3, totalpages: 3, pageindex: 1, itemsperpage: 1 }],
  ])('answers %s, each from the first user tenant holding it, with its extended data', async (_label, query, expected, page) => {
    const data = dataOf(await findMany(REQUESTED, query));
    expect(data).toMatchObject({ entityname: 'address', ...page });
    expect(data.items).toMatchObject(expected.map((name) => ITEMS[name]));
    expect(testApp.db.writes()).toEqual([]);
  });

  it.each([
    ['first', [MISSING, ids.home, ids.work]],
    ['between held ids', [ids.home, MISSING, ids.pooled]],
    ['last, after an address of another site', [ids.elsewhere, ids.home, MISSING]],
  ])('refuses an id no user tenant holds, %s, with the legacy 503', async (_label, requested) => {
    legacyError(await findMany(requested), 'server_error', 503);
    expect(testApp.db.writes()).toEqual([]);
  });

  it('refuses a sorted address findMany with the legacy 503 before reading an address', async () => {
    legacyError(await findMany([ids.home], '&sort=addressid'), 'server_error', 503);
    expect(readsOf('user_address')).toEqual([]);
  });

  it.each<[string, string[], Array<[string, string[]]>, Array<[string, string[]]>]>([
    ['ids tenant-a holds alone', [ids.home, ids.work], [[TENANT_A.tenantId, [ids.home, ids.work]]], [[TENANT_A.tenantId, [ids.home]]]],
    [
      'an id only the public pool holds',
      [ids.home, ids.pooled],
      [[TENANT_A.tenantId, [ids.home, ids.pooled]], [umbrella, [ids.pooled]]],
      [[umbrella, [ids.pooled]]],
    ],
    [
      'every id',
      REQUESTED,
      [[TENANT_A.tenantId, [ids.work, ids.pooled, ids.elsewhere, ids.both, ids.home, ids.umbrellaSite]], [umbrella, [ids.pooled, ids.umbrellaSite]]],
      [[umbrella, [ids.pooled]]],
    ],
  ])('reads %s with one address statement per user tenant still missing ids, and extended data of the page only', async (_label, requested, addressReads, extendReads) => {
    legacyEnvelope(await findMany(requested, '&itemsPerPage=1'), 200);
    expect(readsOf('user_address')).toEqual(addressReads);
    expect(readsOf('extend_data_user_activity')).toEqual(extendReads);
  });

  it('issues as many statements for a page of one over seven ids as over two', async () => {
    const statements = async (requested: readonly string[]): Promise<number> => {
      testApp.db.clear();
      legacyEnvelope(await findMany(requested, '&itemsPerPage=1'), 200);
      return testApp.db.statements().length;
    };
    expect(await statements(REQUESTED)).toBe(await statements([ids.home, ids.pooled]));
  });
});

describe('JSON API unhandled-exception log', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp();
    respondWithRegistry(testApp.db);
  });

  afterAll(async () => {
    await testApp?.close();
  });

  it.each(UNEXPECTED_DB_FAILURES)('answers server_error for %s on a user read, logging only its serialized record', async (_label, failure, safeMessage) => {
    const logs = captureRequestLogs(testApp.app);
    testApp.db.clear();
    testApp.db.respond(/\bFROM \S*\bperson"? WHERE\b/, () => {
      throw failure;
    });

    const res = await send(testApp.app, 'GET', apiPath('json', `/user/${SYSTEM_USER_A.sub}`), await actorHeaders(SITE_ADMIN_A));

    expect(legacyError(res, 'server_error').method).toBe('findOne');
    expect(testApp.db.writes()).toEqual([]);
    expectSerializedErrorLog(logs, 'unhandled JSON API error', safeMessage);
  });
});

describe('iteratorPageHold', () => {
  const NEXT_NS = [1000, 3, 2.5, 1, 0, -2, Number.POSITIVE_INFINITY, Number.NaN];
  const PAGE_SIZES = [undefined, '*', '0', '1', '2', '3', '1.5', '-2', '1e3', '1e400', 'x', ''];
  const PAGES = [undefined, '0', '1', '2', '3', '99', '-1', '1.5', '-0.5', '1e400'];
  const START_INDEXES = [undefined, '0', '1', '2', '3', '4', '7', '99', '-3', '2.5'];
  const MAX_ITEMS = [0, 1, 3, 5];
  const COUNTS = Array.from({ length: 10 }, (_, count) => count);

  /** The url scope of the given iterator params, absent ones left out. */
  function urlOf(itemsPerPage?: string, pageIndex?: string, startIndex?: string): Record<string, string> {
    return Object.fromEntries(Object.entries({ itemsPerPage, pageIndex, startIndex }).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])));
  }

  it.each(PAGE_SIZES.map((size) => [String(size), size]))('holds every position iteratorPage returns for itemsPerPage %s, at every count', (_label, size) => {
    const missed: string[] = [];
    let positions = 0;
    for (const nextN of NEXT_NS) {
      for (const pageIndex of PAGES) {
        for (const startIndex of START_INDEXES) {
          const url = urlOf(size, pageIndex, startIndex);
          for (const maxItems of MAX_ITEMS) {
            const hold = iteratorPageHold(nextN, maxItems, url);
            for (const total of COUNTS) {
              let page: number[];
              try {
                page = iteratorPage(maxItems > 0 ? Math.min(total, maxItems) : total, nextN, url).positions;
              } catch (err) {
                if (err instanceof LegacyApiError) continue;
                throw err;
              }
              positions += page.length;
              for (const position of page) {
                if (!(position < hold.reach && hold.keep(position))) missed.push(JSON.stringify({ nextN, url, maxItems, total, position }));
              }
            }
          }
        }
      }
    }
    expect(missed).toEqual([]);
    expect(positions).toBeGreaterThan(0);
  });

  it.each<[string, number, number, Record<string, string>, number[], number]>([
    ['the first page of the feed nextN', 1000, 0, {}, Array.from({ length: 1000 }, (_, index) => index), 1000],
    ['the first page beside a requested page', 1000, 0, urlOf('2', '3'), [0, 1, 4, 5], 6],
    ['the first page and the page of a start index', 1000, 0, urlOf('3', undefined, '5'), [0, 1, 2, 3, 4, 5], 6],
    ['no row past maxItems', 1000, 3, urlOf('2', '2'), [0, 1, 2], 3],
    ['no row of a negative page size', 1000, 0, urlOf('-2'), [], 0],
  ])('keeps only %s', (_label, nextN, maxItems, url, kept, reach) => {
    const hold = iteratorPageHold(nextN, maxItems, url);
    expect(hold.reach).toBe(reach);
    expect(Array.from({ length: 1100 }, (_, index) => index).filter((index) => index < hold.reach && hold.keep(index))).toEqual(kept);
  });

  it.each<[string, number, number, Record<string, string>, number]>([
    ['itemsPerPage *', 1000, 0, urlOf('*', '2'), Number.POSITIVE_INFINITY],
    ['itemsPerPage 0 under maxItems', 1000, 4, urlOf('0'), 4],
    ['a zero nextN', 0, 0, urlOf(undefined, '2'), Number.POSITIVE_INFINITY],
  ])('keeps every row for %s, whose page size is the count', (_label, nextN, maxItems, url, reach) => {
    const hold = iteratorPageHold(nextN, maxItems, url);
    expect(hold.reach).toBe(reach);
    expect([0, 1, 2, 3, 500].every((index) => hold.keep(index))).toBe(true);
  });
});
