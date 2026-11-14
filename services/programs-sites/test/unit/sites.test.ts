/** Site list order, settingsBean setter guards, the CSRF skip of the Sites screen order save and the refused Edit Site save. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, type TenantFixture } from '@opt2/platform/testing';
import { SITE_COLUMNS, applySet, getSiteValue, listOrderSql, newSiteBean, sortSites, type SiteData } from '../../src/legacy/site-fields.js';
import { buildTestApp, headersFor, type RecordingDb, type TestApp } from '../helpers/app.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const TOKEN_FIELDS = 'csrf_token=T&csrf_token_expires=E';
const CSRF_CONSUME = '/internal/v1/csrf/consume';
const WRITTEN_TABLES = ['programs_sites.site', 'programs_sites.changelog', 'programs_sites.outbox'];
const ORDER_SQL = /^ORDER BY (?:orderno|lower\((?:domain|site)\)) (?:ASC NULLS FIRST|DESC NULLS LAST)$/;

/** A stored `programs_sites.site` row of `fixture`, its other columns NULL, so its pools read as its own. */
function siteRow(fixture: TenantFixture, site: string, orderno: number): Record<string, unknown> {
  const own = fixture.siteId;
  return {
    ...Object.fromEntries(SITE_COLUMNS.map(({ targetName }) => [targetName, null])),
    tenant_id: fixture.tenantId,
    siteid: own,
    site,
    domain: `${own}.example.test`,
    baseid: `${own}-base`,
    orderno,
    deploy: 1,
    lastdeployment: null,
    row_version: '1',
  };
}

// Site names sort opposite to orderno, so the list's default `site` sort is observable.
const STORED_SITES = [siteRow(TENANT_A, 'Zeta Site', 1), siteRow(TENANT_B, 'Alpha Site', 2)];

/** Answers the registry and `programs_sites.site` reads from STORED_SITES. */
function seedSites(db: RecordingDb): void {
  const registry = STORED_SITES.map((row) => ({ tenant_id: row.tenant_id, site_id: row.siteid }));
  db.respond('SELECT tenant_id, site_id FROM programs_sites.tenant_registry ORDER BY site_id', registry);
  db.respond('FROM programs_sites.tenant_registry WHERE lower(site_id) = lower($1)', (params) =>
    registry.filter((entry) => String(entry.site_id).toLowerCase() === String(params[0]).toLowerCase()),
  );
  db.respond(/^SELECT \* FROM "programs_sites"\."site" WHERE /i, (params) =>
    STORED_SITES.filter((row) => row.tenant_id === params[0] && (params[1] === undefined || row.siteid === params[1])),
  );
}

describe('listOrderSql', () => {
  it.each(['name', 'orderno; drop table tsettings', ''])('orders by orderno for the unknown sortBy %j', (sortBy) => {
    const order = listOrderSql(sortBy, 'asc');
    expect(order).toEqual({ column: 'orderno', direction: 'ASC', nulls: 'FIRST', sql: 'ORDER BY orderno ASC NULLS FIRST' });
  });

  it('orders ascending for the unknown direction sideways', () => {
    expect(listOrderSql('domain', 'sideways')).toEqual({
      column: 'domain',
      direction: 'ASC',
      nulls: 'FIRST',
      sql: 'ORDER BY lower(domain) ASC NULLS FIRST',
    });
  });

  it.each([
    ['DOMAIN', 'DESC', 'domain', 'desc'],
    ['Site', 'Asc', 'site', 'asc'],
    ['ORDERNO', 'dEsC', 'orderno', 'desc'],
  ])('accepts %s %s as %s %s', (sortBy, direction, lowerSortBy, lowerDirection) => {
    expect(listOrderSql(sortBy, direction)).toEqual(listOrderSql(lowerSortBy, lowerDirection));
  });

  it('orders domain descending with NULLs last, as SQL Server sorts them lowest', () => {
    expect(listOrderSql('domain', 'desc').sql).toBe('ORDER BY lower(domain) DESC NULLS LAST');
  });

  it.each([
    ['orderno; drop table tsettings', 'asc'],
    ['site', 'desc; delete from tsettings'],
    ['domain--', 'asc'],
    ['site) desc, (select 1', 'desc'],
  ])('builds the SQL from the fixed column and direction names only, for %j / %j', (sortBy, direction) => {
    const { sql } = listOrderSql(sortBy, direction);
    expect(sql).toMatch(ORDER_SQL);
    expect(sql).not.toMatch(/drop|delete|select|tsettings|;|--/i);
  });
});

describe('sortSites', () => {
  const rows = [
    { siteid: 'beta', site: 'Beta', domain: 'c.example', orderno: 3 },
    { siteid: 'alpha', site: 'alpha', domain: 'a.example', orderno: 2 },
    { siteid: 'gamma', site: 'Gamma', domain: 'b.example', orderno: 1 },
  ];
  const ids = (sorted: readonly { siteid: string }[]): string[] => sorted.map((row) => row.siteid);

  it.each([
    ['site', 'asc', ['alpha', 'beta', 'gamma']],
    ['domain', 'desc', ['beta', 'gamma', 'alpha']],
    ['orderno', 'asc', ['gamma', 'alpha', 'beta']],
    ['name', 'asc', ['gamma', 'alpha', 'beta']],
    ['orderno', 'sideways', ['gamma', 'alpha', 'beta']],
  ])('sorts by %s %s', (sortBy, direction, expected) => {
    expect(ids(sortSites(rows, sortBy, direction))).toEqual(expected);
  });

  it('falls back to orderno ascending without arguments and leaves its input unchanged', () => {
    const input = [...rows];
    expect(ids(sortSites(input))).toEqual(['gamma', 'alpha', 'beta']);
    expect(input).toEqual(rows);
  });

  it.each([
    ['SITE', 'ASC', 'site', 'asc'],
    ['Domain', 'Desc', 'domain', 'desc'],
    ['OrderNo', 'DESC', 'orderno', 'desc'],
  ])('sorts by %s %s as by %s %s', (sortBy, direction, lowerSortBy, lowerDirection) => {
    expect(ids(sortSites(rows, sortBy, direction))).toEqual(ids(sortSites(rows, lowerSortBy, lowerDirection)));
  });
});

describe('applySet setter guards', () => {
  it.each([
    ['isRemote', 'abc', '1'],
    ['enforceChangesets', 'x', '1'],
    ['enforcePrimaryDomain', 'yes', '1'],
    ['JSONApi', 'on', '1'],
    ['resourceSSL', 'ssl', '1'],
    ['remotePort', '80a', '8443'],
    ['hasLockableNodes', '', '1'],
  ])('%s ignores the non-numeric %j and keeps the numeric %j', (field, nonNumeric, numeric) => {
    const set = applySet(newSiteBean(), { [field]: numeric });
    expect(getSiteValue(set, field)).toBe(numeric);
    expect(getSiteValue(applySet(set, { [field]: nonNumeric }), field)).toBe(numeric);
  });

  it.each<[string, SiteData, string, string]>([
    ['true', {}, 'true', '1'],
    ['false', { useSSL: 'true' }, 'false', '0'],
    ['maybe', { useSSL: 'true' }, 'maybe', '1'],
  ])('sets useSSL and extranetSSL together for useSSL %s', (_label, start, useSSL, expected) => {
    const bean = applySet(applySet(newSiteBean(), start), { useSSL });
    expect(getSiteValue(bean, 'useSSL')).toBe(expected);
    expect(getSiteValue(bean, 'extranetSSL')).toBe(expected);
  });

  it('leaves useSSL and extranetSSL at 0 for a non-boolean useSSL on a new bean', () => {
    const bean = applySet(newSiteBean(), { useSSL: 'maybe' });
    expect(getSiteValue(bean, 'useSSL')).toBe('0');
    expect(getSiteValue(bean, 'extranetSSL')).toBe('0');
  });

  it.each(['export1', 'EXPORT1'])('ignores the exportLocation %j', (exportLocation) => {
    const set = applySet(newSiteBean(), { exportLocation: '/srv/export' });
    expect(getSiteValue(applySet(set, { exportLocation }), 'exportLocation')).toBe('/srv/export');
  });

  it.each([
    ['bounce+example.com', 'bounce@example.com'],
    ['bounce@example.com', 'bounce@example.com'],
  ])('derives mailServerUsernameEmail %s -> %s and keeps the username as given', (username, email) => {
    const bean = applySet(newSiteBean(), { mailServerUsername: username });
    expect(getSiteValue(bean, 'mailServerUsernameEmail')).toBe(email);
    expect(getSiteValue(bean, 'mailServerUsername')).toBe(username);
  });
});

const ORDER_PAYLOAD = `orderID=${TENANT_A.siteId}&orderID=${TENANT_B.siteId}&orderno=2&orderno=1&deploy=0&deploy=1&${TOKEN_FIELDS}`;

describe('CSRF validation of the site saves', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
    seedSites(t.db);
  });

  afterEach(async () => {
    await t.app.close();
  });

  async function send(url: string, subject: string, site: string, payload: string) {
    const headers = { ...(await headersFor(subject, { site })), ...FORM };
    return t.app.inject({ method: 'POST', url, headers, payload });
  }

  function consumedContexts(): unknown[] {
    return t.client.requestsTo('identity', CSRF_CONSUME).map((call) => (call.json as { context?: unknown }).context);
  }

  it('writes nothing on the Sites screen order save when identity rejects the token', async () => {
    t.client.csrfValid(false);
    const res = await send('/v1/sites/order', 's2', 'default', ORDER_PAYLOAD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      written: false,
      sites: [
        { siteid: TENANT_B.siteId, orderno: 2, deploy: 1 },
        { siteid: TENANT_A.siteId, orderno: 1, deploy: 1 },
      ],
    });
    expect(t.db.writes()).toEqual([]);
    expect(consumedContexts()).toEqual(['updatesites']);
  });

  it('writes site, changelog and outbox rows on the Sites screen order save for a valid token', async () => {
    t.client.csrfValid(true);
    const res = await send('/v1/sites/order', 's2', 'default', ORDER_PAYLOAD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ written: true });
    for (const table of WRITTEN_TABLES) expect(t.db.writesTo(table).length).toBeGreaterThan(0);
    expect(consumedContexts()).toEqual(['updatesites']);
  });

  it.each(['site-admin', 's2'])('refuses the withheld Edit Site save of a %s with a valid token with the legacy 503, consuming, reading and writing nothing', async (subject) => {
    t.client.csrfValid(true);
    const payload = `siteid=${TENANT_A.siteId}&action=Update&site=Renamed&${TOKEN_FIELDS}`;
    const res = await send(`/v1/sites/${TENANT_A.siteId}/update`, subject, TENANT_A.siteId, payload);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error' } });
    expect(t.client.requestsTo('identity')).toEqual([]);
    expect(t.db.statements()).toEqual([]);
    expect(t.publisher.published).toEqual([]);
  });
});

/** The step of a site-list transaction a statement is. */
function listStep(sql: string): string {
  if (sql === 'BEGIN' || sql === 'COMMIT') return sql;
  if (/^SELECT set_config\('app\.tenant_id'/.test(sql)) return 'set tenant';
  if (sql === 'SAVEPOINT opt2_read_fence' || sql === 'RELEASE SAVEPOINT opt2_read_fence') return sql;
  if (/^SELECT unit, phase FROM .*unit_gate.* FOR SHARE NOWAIT$/.test(sql)) return 'gate fence';
  if (sql.startsWith('SELECT tenant_id, site_id FROM programs_sites.tenant_registry')) return 'registry';
  if (/^SELECT \* FROM "programs_sites"\."site" WHERE /.test(sql)) return 'sites';
  return sql;
}

describe('GET /v1/sites statements', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
    seedSites(t.db);
  });

  afterEach(async () => {
    await t.app.close();
  });

  it('reads the registry once behind one gate fence, then each tenant in its own fenced transaction of 7 statements', async () => {
    t.db.clear();
    const res = await t.app.inject({ method: 'GET', url: '/v1/sites', headers: await headersFor('s2', { site: 'default' }) });

    expect(res.statusCode).toBe(200);
    const steps = t.db.statements().map((statement) => ({ step: listStep(statement.sql), tenantId: statement.tenantId }));
    const tenants = STORED_SITES.map((row) => row.tenant_id);
    const perTransaction = ['BEGIN', 'set tenant', 'SAVEPOINT opt2_read_fence', 'gate fence', 'RELEASE SAVEPOINT opt2_read_fence', 'COMMIT'];
    const expected = [...perTransaction, 'registry', ...tenants.flatMap(() => [...perTransaction, 'sites'])];
    expect(steps).toHaveLength(7 * tenants.length + 7);
    expect(steps.map(({ step }) => step).sort()).toEqual(expected.sort());
    expect(steps.filter(({ step }) => step === 'sites').map(({ tenantId }) => tenantId).sort()).toEqual([...tenants].sort());
    expect(steps.filter(({ step }) => step === 'registry')).toEqual([{ step: 'registry', tenantId: null }]);
  });
});
