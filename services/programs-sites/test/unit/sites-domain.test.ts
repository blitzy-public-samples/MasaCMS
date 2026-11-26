/** Site operations of csettings list, editSite and the order form over recording fakes of the tenant database, repository and site.changed writer. */
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { AppliedChange, WriteContext } from '@opt2/platform/migration-kit';
import {
  registeredTenants,
  registryEntryForTenant,
  tenantForRegisteredSite,
  tenantIdForSite,
  type MetadataTx,
  type QueryResult,
  type TenantDb,
  type TenantRegistryEntry,
  type TenantTx,
  type TransactionCallOptions,
} from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, loadOpenApiDocument } from '@opt2/platform/testing';
import { siteChangedPayload } from '../../src/domain/pools.js';
import { createSitesDomain, type SitesDomainDeps } from '../../src/domain/sites.js';
import { siteChangedValidator } from '../../src/events/consumers.js';
import { lastAnnouncedVersion, writeSiteChanged } from '../../src/events/site-changed.js';
import { SITE_COLUMNS } from '../../src/legacy/site-fields.js';
import type { KeysetPage, ProgramsSitesRepository, SiteExtendDefinitions, SiteListRow } from '../../src/repo/repository.js';
import {
  SITE,
  type ExtendAttributeRow,
  type ExtendDataRow,
  type ExtendSetRow,
  type ExtendSubtypeRow,
  type ImageSizeRow,
  type SiteRow,
} from '../../src/repo/tables.js';

vi.mock('@opt2/platform/tenancy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tenancy')>();
  return { ...actual, registeredTenants: vi.fn(), registryEntryForTenant: vi.fn(), tenantForRegisteredSite: vi.fn() };
});

vi.mock('../../src/events/site-changed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/events/site-changed.js')>();
  return { ...actual, writeSiteChanged: vi.fn(), lastAnnouncedVersion: vi.fn() };
});

const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const TENANT_DEFAULT = tenantIdForSite('default');
const BASE_ID = 'B0000000-0000-0000-0000000000000001';
const SUBTYPE = 'S0000000-0000-0000-0000000000000001';
const PAGE_SUBTYPE = 'S0000000-0000-0000-0000000000000002';
const OTHER_SUBTYPE = 'S0000000-0000-0000-0000000000000003';
const SET_1 = 'E0000000-0000-0000-0000000000000001';
const SET_2 = 'E0000000-0000-0000-0000000000000002';
const PAGE_SET = 'E0000000-0000-0000-0000000000000003';
const OTHER_SET = 'E0000000-0000-0000-0000000000000004';
const SIZE_ID = 'A0000000-0000-0000-0000000000000001';
const LAST_DEPLOYMENT = new Date(2026, 0, 2, 3, 4, 5, 6);
const LAUNCH = new Date(2026, 2, 4, 5, 6, 7, 0);
const OPENAPI = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as object;
/** The read fence `awaitReadable` takes on the site unit of an open gate: savepoint, share lock, release. */
const SITE_UNIT_FENCE = [
  ['SAVEPOINT opt2_read_fence', undefined],
  [expect.stringMatching(/^SELECT unit, phase FROM \S*unit_gate\S* WHERE unit = ANY\(\$1::text\[\]\) ORDER BY unit FOR SHARE NOWAIT$/), [[SITE.unit]]],
  ['RELEASE SAVEPOINT opt2_read_fence', undefined],
];

function claimsFor(site: string, s2 = true): UserClaims {
  const roles = s2 ? ['s2'] : ['site-admin'];
  return { iss: 'test', aud: 'test', sub: 'U1', sid: 'S1', tid: tenantIdForSite(site), site, roles, s2, epoch: 0, iat: 0, exp: 0 };
}

function siteRow(siteid: string, overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    tenant_id: tenantIdForSite(siteid),
    siteid,
    site: `Site ${siteid}`,
    domain: `${siteid}.example.test`,
    orderno: 1,
    deploy: 1,
    lastdeployment: null,
    baseid: BASE_ID,
    row_version: '1',
    usessl: 0,
    extranetssl: 0,
    publicuserpoolid: null,
    privateuserpoolid: null,
    displaypoolid: null,
    filepoolid: null,
    categorypoolid: null,
    contentpoolid: null,
    ...overrides,
  };
}

function subtype(overrides: Partial<ExtendSubtypeRow> = {}): ExtendSubtypeRow {
  return {
    tenant_id: TENANT_A,
    subtypeid: SUBTYPE,
    siteid: 'tenant-a',
    basetable: 'tsettings',
    basekeyfield: 'baseID',
    datatable: 'tclassextenddata',
    type: 'Site',
    subtype: 'Default',
    isactive: 1,
    notes: null,
    lastupdate: null,
    datecreated: null,
    lastupdateby: null,
    hassummary: 0,
    hasbody: 0,
    description: null,
    availablesubtypes: null,
    iconclass: null,
    hasassocfile: 0,
    hasconfigurator: 0,
    adminonly: 0,
    ...overrides,
  };
}

function extendSet(extendsetid: string, overrides: Partial<ExtendSetRow> = {}): ExtendSetRow {
  return {
    tenant_id: TENANT_A,
    extendsetid,
    subtypeid: SUBTYPE,
    categoryid: null,
    siteid: 'tenant-a',
    name: `Set ${extendsetid.slice(-1)}`,
    orderno: 1,
    isactive: 1,
    container: 'Default',
    ...overrides,
  };
}

function attribute(attributeid: number, name: string, overrides: Partial<ExtendAttributeRow> = {}): ExtendAttributeRow {
  return {
    tenant_id: TENANT_A,
    attributeid,
    extendsetid: SET_1,
    siteid: 'tenant-a',
    name,
    label: name,
    hint: null,
    type: 'TextBox',
    orderno: attributeid,
    isactive: 1,
    required: 'false',
    validation: null,
    regex: null,
    message: null,
    defaultvalue: null,
    optionlist: null,
    optionlabellist: null,
    adminonly: 0,
    ...overrides,
  };
}

function stored(dataid: number, attributeid: number, attributevalue: string | null, datetimevalue: Date | null = null): ExtendDataRow {
  return { tenant_id: TENANT_A, dataid, baseid: BASE_ID, attributeid, siteid: 'tenant-a', attributevalue, remoteid: null, datetimevalue, numericvalue: null, stringvalue: attributevalue };
}

function emptyDefinitions(): SiteExtendDefinitions {
  return { subtypes: [], sets: [], attributes: [], rcsets: [] };
}

/** Site/Default subtype with sets 1 and 2, Page and Site/Other subtype sets, and attributes of every saved kind. */
function siteDefinitions(): SiteExtendDefinitions {
  return {
    subtypes: [subtype(), subtype({ subtypeid: PAGE_SUBTYPE, type: 'Page' }), subtype({ subtypeid: OTHER_SUBTYPE, subtype: 'Other' })],
    sets: [
      extendSet(SET_1),
      extendSet(SET_2, { container: 'Sidebar' }),
      extendSet(PAGE_SET, { subtypeid: PAGE_SUBTYPE }),
      extendSet(OTHER_SET, { subtypeid: OTHER_SUBTYPE }),
    ],
    attributes: [
      attribute(1, 'color', { defaultvalue: 'red' }),
      attribute(2, 'size', { validation: 'Numeric', defaultvalue: '5' }),
      attribute(3, 'launch', { validation: 'Date' }),
      attribute(4, 'notes', { type: null }),
      attribute(5, 'logo', { type: 'File' }),
      attribute(6, 'motto', { extendsetid: SET_2 }),
      attribute(7, 'pageonly', { extendsetid: PAGE_SET, defaultvalue: 'page' }),
      attribute(10, 'otheronly', { extendsetid: OTHER_SET, defaultvalue: 'other' }),
    ],
    rcsets: [],
  };
}

interface Store {
  sites: Map<string, SiteRow[]>;
  defs: SiteExtendDefinitions;
  data: ExtendDataRow[];
  imageSizes: ImageSizeRow[];
  registry: { siteId: string; tenantId: string }[];
}

function newStore(rows: SiteRow[] = []): Store {
  const sites = new Map<string, SiteRow[]>();
  for (const row of rows) sites.set(row.tenant_id, [...(sites.get(row.tenant_id) ?? []), row]);
  return { sites, defs: emptyDefinitions(), data: [], imageSizes: [], registry: rows.map((row) => ({ siteId: row.siteid, tenantId: row.tenant_id })) };
}

/** The columns the repository's `listSites` selects. */
const LIST_COLUMNS = ['siteid', 'site', 'domain', 'orderno', 'deploy', 'lastdeployment'] as const;

/** SQL Server's `siteid = ?`: case-insensitive, trailing spaces ignored. */
function sqlServerEq(stored: string, siteId: string): boolean {
  return stored.replace(/ +$/, '').toLowerCase() === siteId.replace(/ +$/, '').toLowerCase();
}

/** Recording repository over `store`; site writes replace the stored row and advance its row_version. */
function fakeRepo(store: Store) {
  const rowsOf = (tx: TenantTx): SiteRow[] => store.sites.get(tx.tenantId) ?? [];
  const replace = (tx: TenantTx, siteId: string, patch: Readonly<Record<string, unknown>>, bump: boolean): SiteRow | null => {
    const rows = rowsOf(tx);
    const index = rows.findIndex((row) => row.siteid === siteId);
    const current = rows[index];
    if (current === undefined) return null;
    const version = bump ? { row_version: String(BigInt(current.row_version) + 1n) } : {};
    const next = { ...current, ...patch, ...version } as SiteRow;
    rows[index] = next;
    return next;
  };
  return {
    readSite: vi.fn(async (tx: TenantTx, siteId: string) => rowsOf(tx).find((row) => row.siteid === siteId) ?? null),
    listSites: vi.fn(async (tx: TenantTx) =>
      rowsOf(tx).map((row) => Object.fromEntries(LIST_COLUMNS.map((column) => [column, row[column]])) as SiteListRow),
    ),
    matchSite: vi.fn(async (tx: TenantTx, siteId: string) => rowsOf(tx).find((row) => sqlServerEq(row.siteid, siteId)) ?? null),
    listRegisteredSitePage: vi.fn(async (_tx: MetadataTx, { after, limit }: KeysetPage) =>
      [...store.registry]
        .sort((a, b) => a.siteId.localeCompare(b.siteId))
        .filter(({ siteId }) => after === null || siteId.localeCompare(after) > 0)
        .slice(0, limit),
    ),
    readSiteExtendDefinitions: vi.fn(async (_tx: TenantTx, _siteId: string) => store.defs),
    readSiteExtendData: vi.fn(async (_tx: TenantTx, baseId: string) => store.data.filter((row) => row.baseid === baseId)),
    listImageSizes: vi.fn(async (_tx: TenantTx, siteId: string) => store.imageSizes.filter((row) => row.siteid === siteId)),
    updateOrderNo: vi.fn(async (tx: TenantTx, siteId: string, orderno: number) => replace(tx, siteId, { orderno }, true)),
    updateDeploy: vi.fn(async (tx: TenantTx, siteId: string, deploy: number) => replace(tx, siteId, { deploy }, true)),
    update: vi.fn(async (tx: TenantTx, _table: string, key: Readonly<Record<string, unknown>>, patch: Readonly<Record<string, unknown>>, _ctx?: WriteContext) =>
      replace(tx, String(key.siteid), patch, false),
    ),
  };
}

type FakeRepo = ReturnType<typeof fakeRepo>;

const WRITE_METHODS = ['updateOrderNo', 'updateDeploy', 'update'] as const;

function tenantTx(tenantId: string): TenantTx {
  const reject = (): Promise<never> => Promise.reject(new Error('SQL issued against the fake transaction'));
  return { kind: 'tenant', tenantId, schema: 'programs_sites', query: reject, onCommit: vi.fn() };
}

/** Text and values of one statement a fake transaction received. */
type Statement = [text: string, values: unknown[] | undefined];

/** A metadata transaction answering every statement with no rows and recording it in `seen`. */
function metadataTx(seen: Statement[]): MetadataTx {
  const query = (text: string | { text: string }, values?: unknown[]): Promise<QueryResult> => {
    seen.push([typeof text === 'string' ? text : text.text, values]);
    return Promise.resolve({ command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] });
  };
  return { kind: 'metadata', schema: 'programs_sites', query: query as MetadataTx['query'], onCommit: vi.fn() };
}

interface Harness {
  db: TenantDb;
  repo: FakeRepo;
  store: Store;
  opened: string[];
  /** Statements of each metadata transaction opened, one list per transaction. */
  metadata: Statement[][];
  domain: ReturnType<typeof createSitesDomain>;
}

function harness(rows: SiteRow[] = [], deps: Omit<SitesDomainDeps, 'repo'> = {}): Harness {
  const store = newStore(rows);
  const repo = fakeRepo(store);
  const opened: string[] = [];
  const metadata: Statement[][] = [];
  const db: TenantDb = {
    schema: 'programs_sites',
    withTenant: (tenantId, fn) => {
      opened.push(tenantId);
      return fn(tenantTx(tenantId));
    },
    withMetadata: (fn) => {
      const seen: Statement[] = [];
      metadata.push(seen);
      return fn(metadataTx(seen));
    },
    end: () => Promise.resolve(),
  };
  vi.mocked(registeredTenants).mockImplementation(async () =>
    [...store.registry].sort((a, b) => a.siteId.localeCompare(b.siteId)),
  );
  vi.mocked(tenantForRegisteredSite).mockImplementation(
    async (_db, siteId) => store.registry.find((entry) => entry.siteId.toLowerCase() === siteId.toLowerCase())?.tenantId ?? null,
  );
  const domain = createSitesDomain({ repo: repo as unknown as ProgramsSitesRepository, ...deps });
  return { db, repo, store, opened, metadata, domain };
}

function writesOf(repo: FakeRepo): string[] {
  return WRITE_METHODS.filter((method) => repo[method].mock.calls.length > 0);
}

/** The site.changed writes, as transaction tenant, site, row version and origin. */
function announced(): { tenantId: string; siteId: string; rowVersion: bigint | number; origin?: string }[] {
  return vi.mocked(writeSiteChanged).mock.calls.map(([tx, args]) => ({
    tenantId: tx.tenantId,
    siteId: args.siteId,
    rowVersion: args.rowVersion,
    origin: args.origin,
  }));
}

function assertContract(method: string, path: string, body: unknown): void {
  assertResponseMatchesOpenApi(OPENAPI, { method, path, status: 200, contentType: 'application/json', body });
}

beforeEach(() => {
  vi.mocked(writeSiteChanged).mockReset().mockResolvedValue(null);
  vi.mocked(lastAnnouncedVersion).mockReset().mockResolvedValue(0n);
  vi.mocked(registeredTenants).mockReset();
  vi.mocked(registryEntryForTenant).mockReset();
  vi.mocked(tenantForRegisteredSite).mockReset();
});

describe('listSites', () => {
  const rows = (): SiteRow[] => [
    siteRow('tenant-a', { site: 'beta', domain: 'B.example.test', orderno: 2 }),
    siteRow('tenant-b', { site: 'Alpha', domain: 'c.example.test', orderno: null }),
    siteRow('default', { site: 'gamma', domain: 'a.example.test', orderno: 1 }),
  ];

  it.each<{ name: string; sortBy?: string; sortDirection?: string; expected: string[] }>([
    { name: 'the default orderno asc, NULL first', expected: ['tenant-b', 'default', 'tenant-a'] },
    { name: 'SITE DESC, case-insensitively', sortBy: 'SITE', sortDirection: 'DESC', expected: ['default', 'tenant-a', 'tenant-b'] },
    { name: 'domain asc, case-insensitively', sortBy: 'domain', sortDirection: 'asc', expected: ['default', 'tenant-a', 'tenant-b'] },
    { name: 'orderno desc, NULL last', sortBy: 'orderno', sortDirection: 'desc', expected: ['tenant-a', 'default', 'tenant-b'] },
    { name: 'orderno asc for an unknown column and direction', sortBy: 'contact', sortDirection: 'sideways', expected: ['tenant-b', 'default', 'tenant-a'] },
  ])('sorts every registered site for S2 by $name as settingsGateway.getList does', async ({ sortBy, sortDirection, expected }) => {
    const { db, domain, opened, metadata } = harness(rows());

    const sites = await domain.listSites(db, claimsFor('default'), { sortBy, sortDirection });

    expect(sites.map((site) => site.siteid)).toEqual(expected);
    expect(opened).toEqual([TENANT_DEFAULT, TENANT_A, TENANT_B]);
    expect(registeredTenants).toHaveBeenCalledOnce();
    expect(vi.mocked(registeredTenants).mock.calls[0]?.[0]).toMatchObject({ kind: 'metadata' });
    expect(metadata).toEqual([SITE_UNIT_FENCE]);
  });

  it('lists only the token tenant for a non-S2 token without reading the registry', async () => {
    const { db, domain, opened, metadata } = harness(rows());

    const sites = await domain.listSites(db, claimsFor('tenant-a', false));

    expect(sites.map((site) => site.siteid)).toEqual(['tenant-a']);
    expect(opened).toEqual([TENANT_A]);
    expect(registeredTenants).not.toHaveBeenCalled();
    expect(metadata).toEqual([]);
  });

  it('reads a tenant registered under two site ids once', async () => {
    const { db, domain, opened, store } = harness(rows());
    store.registry.push({ siteId: 'tenant-a-alias', tenantId: TENANT_A });

    const sites = await domain.listSites(db, claimsFor('default'));

    expect(opened).toEqual([TENANT_DEFAULT, TENANT_A, TENANT_B]);
    expect(sites).toHaveLength(3);
  });

  it('maps rows to the Sites screen fields, non-text names as null and lastDeployment as a local timestamp', async () => {
    const { db, domain } = harness([siteRow('tenant-a', { site: null, domain: 7, orderno: 4, deploy: 0, lastdeployment: LAST_DEPLOYMENT })]);

    const sites = await domain.listSites(db, claimsFor('tenant-a', false));

    expect(sites).toStrictEqual([
      { siteid: 'tenant-a', site: null, domain: null, orderno: 4, deploy: 0, lastDeployment: '2026-01-02T03:04:05.006' },
    ]);
    assertContract('GET', '/v1/sites', sites);
  });

  const SITE_IDS = Array.from({ length: 10 }, (_, n) => `site-${String(n).padStart(2, '0')}`);
  /** Two tied rows per tenant, so only tenant order and row order decide the listed order. */
  const manyRows = (): SiteRow[] =>
    SITE_IDS.flatMap((siteid) => [siteRow(siteid, { orderno: 1 }), siteRow(`${siteid}-b`, { tenant_id: tenantIdForSite(siteid), orderno: 1 })]);

  /** `h.db` recording each transaction's options and the most tenant transactions open at once; later tenants answer first. */
  function tracking(h: Harness, onRead: (index: number) => void = () => undefined) {
    const tenantCalls: { tenantId: string; options: TransactionCallOptions | undefined }[] = [];
    const metadataCalls: (TransactionCallOptions | undefined)[] = [];
    let open = 0;
    let peak = 0;
    const db: TenantDb = {
      ...h.db,
      withTenant: async (tenantId, fn, options) => {
        const index = tenantCalls.push({ tenantId, options }) - 1;
        open += 1;
        peak = Math.max(peak, open);
        try {
          onRead(index);
          await sleep(2 * (SITE_IDS.length - index));
          return await h.db.withTenant(tenantId, fn);
        } finally {
          open -= 1;
        }
      },
      withMetadata: (fn, options) => {
        metadataCalls.push(options);
        return h.db.withMetadata(fn);
      },
    };
    return { db, tenantCalls, metadataCalls, peak: () => peak };
  }

  it('reads many tenants at most four at a time, in one registry read, keeping tenant order for the stable sort', async () => {
    const h = harness(manyRows());
    const t = tracking(h);
    const { signal } = new AbortController();

    const sites = await h.domain.listSites(t.db, claimsFor('default'), { signal });

    expect(sites.map((site) => site.siteid)).toEqual(SITE_IDS.flatMap((siteid) => [siteid, `${siteid}-b`]));
    expect(t.peak()).toBe(4);
    expect(t.tenantCalls).toEqual(SITE_IDS.map((siteid) => ({ tenantId: tenantIdForSite(siteid), options: { signal } })));
    expect(t.metadataCalls).toEqual([{ signal }]);
    expect(h.metadata).toEqual([SITE_UNIT_FENCE]);
    expect(registeredTenants).toHaveBeenCalledOnce();
  });

  it.each([
    ['an S2 token', true, SITE_IDS.length],
    ['a non-S2 token', false, 1],
  ] as const)('passes no transaction options for %s when no signal is given', async (_label, s2, reads) => {
    const h = harness(manyRows());
    const t = tracking(h);

    await h.domain.listSites(t.db, claimsFor('site-00', s2));

    expect(t.tenantCalls).toHaveLength(reads);
    expect(t.tenantCalls.every((call) => call.options === undefined)).toBe(true);
    expect(t.metadataCalls).toEqual(s2 ? [undefined] : []);
  });

  it('passes the signal to the single tenant transaction of a non-S2 token', async () => {
    const h = harness(manyRows());
    const t = tracking(h);
    const { signal } = new AbortController();

    const sites = await h.domain.listSites(t.db, claimsFor('site-03', false), { signal });

    expect(sites.map((site) => site.siteid)).toEqual(['site-03', 'site-03-b']);
    expect(t.tenantCalls).toEqual([{ tenantId: tenantIdForSite('site-03'), options: { signal } }]);
    expect(t.metadataCalls).toEqual([]);
  });

  it.each([
    ['before the list starts', -1, 0],
    ['during the second read', 1, 2],
    ['during the fourth read', 3, 4],
  ] as const)('starts no tenant transaction once the signal aborts %s and rejects with its reason', async (_label, abortAt, started) => {
    const h = harness(manyRows());
    const controller = new AbortController();
    const reason = new Error('client closed');
    const t = tracking(h, (index) => {
      if (index === abortAt) controller.abort(reason);
    });
    if (abortAt < 0) controller.abort(reason);

    await expect(h.domain.listSites(t.db, claimsFor('default'), { signal: controller.signal })).rejects.toBe(reason);
    expect(t.tenantCalls).toHaveLength(started);
    expect(t.metadataCalls).toEqual([{ signal: controller.signal }]);
  });

  it('starts no further tenant read after one fails and rethrows that failure once the running reads settle', async () => {
    const h = harness(manyRows());
    const failure = new LegacyServiceUnavailableError('read blocked', 'auto', 'unit-read-blocked');
    // The fourth tenant answers first of the four running, so its failure lands before any worker moves on.
    const failing = tenantIdForSite('site-03');
    h.repo.listSites.mockImplementation(async (tx: TenantTx) => {
      if (tx.tenantId === failing) throw failure;
      return (h.store.sites.get(tx.tenantId) ?? []).map((row) => Object.fromEntries(LIST_COLUMNS.map((column) => [column, row[column]])) as SiteListRow);
    });
    const t = tracking(h);

    await expect(h.domain.listSites(t.db, claimsFor('default'))).rejects.toBe(failure);
    expect(t.tenantCalls).toHaveLength(4);
    expect(h.repo.listSites).toHaveBeenCalledTimes(4);
  });
});

describe('listSitePage', () => {
  const rows = (): SiteRow[] => [siteRow('tenant-a', { orderno: 2 }), siteRow('tenant-b', { orderno: null }), siteRow('default', { orderno: 1 })];

  it.each<{ name: string; after?: string; limit: number; items: string[]; next: string | null; requested: KeysetPage }>([
    { name: 'the first page', limit: 2, items: ['default', 'tenant-a'], next: 'tenant-a', requested: { after: null, limit: 3 } },
    { name: 'the last page after a cursor', after: 'tenant-a', limit: 2, items: ['tenant-b'], next: null, requested: { after: 'tenant-a', limit: 3 } },
    { name: 'a page holding exactly every site', limit: 3, items: ['default', 'tenant-a', 'tenant-b'], next: null, requested: { after: null, limit: 4 } },
  ])('reads $name in site-id order, opening only its tenants behind one gate fence', async ({ after, limit, items, next, requested }) => {
    const { db, domain, opened, metadata, repo } = harness(rows());

    const page = await domain.listSitePage(db, claimsFor('default'), { after, limit });

    expect(page.items.map((site) => site.siteid)).toEqual(items);
    expect(page.next).toBe(next);
    expect(opened).toEqual(items.map((siteId) => tenantIdForSite(siteId)));
    expect(metadata).toEqual([SITE_UNIT_FENCE]);
    expect(repo.listRegisteredSitePage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'metadata' }), requested);
    expect(registeredTenants).not.toHaveBeenCalled();
    assertContract('GET', '/v2/sites', page);
  });

  it('maps rows to the Sites screen fields of the list', async () => {
    const { db, domain } = harness([siteRow('tenant-a', { site: null, domain: 7, orderno: 4, deploy: 0, lastdeployment: LAST_DEPLOYMENT })]);

    expect(await domain.listSitePage(db, claimsFor('tenant-a'), { limit: 1 })).toStrictEqual({
      items: await domain.listSites(db, claimsFor('tenant-a', false)),
      next: null,
    });
  });

  it('reads a tenant registered under two site ids of one page once', async () => {
    const { db, domain, opened, store } = harness(rows());
    store.registry.push({ siteId: 'tenant-a-alias', tenantId: TENANT_A });

    const page = await domain.listSitePage(db, claimsFor('default'), { limit: 3 });

    expect(page).toMatchObject({ items: [{ siteid: 'default' }, { siteid: 'tenant-a' }], next: 'tenant-a-alias' });
    expect(opened).toEqual([TENANT_DEFAULT, TENANT_A]);
  });

  it('denies a non-S2 token with 403 before any read', async () => {
    const { db, domain, opened, metadata, repo } = harness(rows());

    await expect(domain.listSitePage(db, claimsFor('tenant-a', false), { limit: 2 })).rejects.toMatchObject({ statusCode: 403 });
    expect([opened, metadata]).toEqual([[], []]);
    expect(repo.listRegisteredSitePage).not.toHaveBeenCalled();
  });

  it.each([
    ['passes its signal to every transaction', false],
    ['opens no tenant transaction once its signal has aborted, rejecting with the reason', true],
  ])('%s', async (_label, aborted) => {
    const h = harness(rows());
    const controller = new AbortController();
    const reason = new Error('client closed');
    if (aborted) controller.abort(reason);
    const options: (TransactionCallOptions | undefined)[] = [];
    const db: TenantDb = {
      ...h.db,
      withTenant: (tenantId, fn, call) => {
        options.push(call);
        return h.db.withTenant(tenantId, fn);
      },
      withMetadata: (fn, call) => {
        options.push(call);
        return h.db.withMetadata(fn);
      },
    };

    const page = h.domain.listSitePage(db, claimsFor('default'), { limit: 2, signal: controller.signal });

    if (aborted) await expect(page).rejects.toBe(reason);
    else expect((await page).items).toHaveLength(2);
    expect(options).toEqual(Array.from({ length: aborted ? 1 : 3 }, () => ({ signal: controller.signal })));
  });
});

describe('readSite', () => {
  it('denies another site with 403 before opening a transaction', async () => {
    const { db, domain, opened } = harness([siteRow('tenant-b')]);

    await expect(domain.readSite(db, claimsFor('tenant-a'), 'tenant-b')).rejects.toMatchObject({ statusCode: 403 });
    expect(opened).toEqual([]);
  });

  it('reads bean-held fields as the bean holds them and the other columns as stored', async () => {
    const archived = new Date(2025, 11, 31, 23, 59, 58, 1);
    const { db, domain, repo, store } = harness([
      siteRow('tenant-a', {
        site: 'Alpha',
        orderno: 3,
        deploy: 0,
        lastdeployment: LAST_DEPLOYMENT,
        pagelimit: 500,
        maxnestlevel: 7,
        filedir: 'files',
        archivedate: archived,
        gallerymainscale: 4,
        emailbroadcaster: 1,
        largeimagewidth: 'abc',
        contentpoolid: 'tenant-a,default',
      }),
    ]);
    store.imageSizes = [{ tenant_id: TENANT_A, sizeid: SIZE_ID, siteid: 'tenant-a', name: 'hero', height: null, width: '640' }];

    const detail = await domain.readSite(db, claimsFor('tenant-a'), 'tenant-a');

    expect(Object.keys(detail.site)).toEqual(SITE_COLUMNS.map((column) => column.legacyName));
    expect(detail.site).toMatchObject({
      SiteID: 'tenant-a',
      Site: 'Alpha',
      orderNo: 3,
      deploy: 0,
      lastDeployment: '2026-01-02T03:04:05.006',
      PageLimit: 500,
      MaxNestLevel: 7,
      FileDir: 'files',
      archiveDate: '2025-12-31T23:59:58.001',
      galleryMainScale: 4,
      EmailBroadcaster: 1,
      largeImageWidth: '600',
      baseID: BASE_ID,
      publicUserPoolID: 'tenant-a',
      displayPoolID: 'tenant-a',
      contentPoolID: 'tenant-a,default',
      Locking: '',
    });
    expect(detail.isNew).toBe(0);
    expect(detail.imageSizes).toEqual([{ sizeID: SIZE_ID, siteID: 'tenant-a', name: 'hero', height: 'AUTO', width: '640', isNew: 0 }]);
    expect(repo.readSiteExtendData).toHaveBeenCalledOnce();
    expect(writesOf(repo)).toEqual([]);
    assertContract('GET', '/v1/sites/tenant-a', detail);
  });

  it('lists the active Site/Default sets of container Default with the last stored value of each attribute', async () => {
    const { db, domain, store } = harness([siteRow('tenant-a')]);
    store.defs = siteDefinitions();
    store.defs.subtypes[0] = subtype({ type: 'SITE', subtype: 'default ' });
    store.data = [stored(1, 1, 'old'), stored(2, 1, 'new'), stored(3, 6, 'kept')];

    const { extendSets } = await domain.readSite(db, claimsFor('tenant-a'), 'tenant-a');

    expect(extendSets.map((set) => set.extendSetID)).toEqual([SET_1]);
    expect(extendSets[0]).toMatchObject({ subTypeID: SUBTYPE, siteID: 'tenant-a', name: 'Set 1', container: 'Default', isActive: 1 });
    expect(extendSets[0]?.attributes.map((entry) => [entry.attributeID, entry.name, entry.value])).toEqual([
      [1, 'color', 'new'],
      [2, 'size', null],
      [3, 'launch', null],
      [4, 'notes', null],
      [5, 'logo', null],
    ]);
  });

  it.each<{ name: string; defs: () => SiteExtendDefinitions }>([
    { name: 'inactive', defs: () => ({ ...siteDefinitions(), subtypes: [subtype({ isactive: 0 })] }) },
    { name: 'absent', defs: () => ({ ...siteDefinitions(), subtypes: [] }) },
    { name: 'of another type', defs: () => ({ ...siteDefinitions(), subtypes: [subtype({ type: 'Page' })] }) },
  ])('answers no extend sets when the Site/Default subtype is $name', async ({ defs }) => {
    const { db, domain, store } = harness([siteRow('tenant-a')]);
    store.defs = defs();

    expect((await domain.readSite(db, claimsFor('tenant-a'), 'tenant-a')).extendSets).toEqual([]);
  });

  it('reads an unknown id as the defaulted new site under a fresh baseID with isNew 1', async () => {
    const { db, domain, repo } = harness([]);

    const detail = await domain.readSite(db, claimsFor('tenant-a'), 'tenant-a');

    expect(detail).toMatchObject({ isNew: 1, extendSets: [], imageSizes: [] });
    expect(detail.site).toMatchObject({
      SiteID: '',
      PageLimit: 1000,
      Locking: 'None',
      largeImageHeight: 'AUTO',
      largeImageWidth: '600',
      orderNo: 0,
      deploy: 1,
      lastDeployment: null,
      MaxNestLevel: null,
      publicUserPoolID: '',
    });
    expect(detail.site.baseID).toMatch(CF_UUID);
    expect(repo.readSiteExtendDefinitions).toHaveBeenCalledWith(expect.anything(), 'tenant-a');
    expect(repo.readSiteExtendData).not.toHaveBeenCalled();
    expect(repo.listImageSizes).not.toHaveBeenCalled();
    assertContract('GET', '/v1/sites/tenant-a', detail);
  });

  it.each([
    ['the exact stored id without a fallback lookup', 'tenant-a', 0],
    ['a stored id that differs in case through one fallback lookup', 'Tenant-A', 1],
  ])('finds %s and reads its parts under the stored id, never listing the tenant', async (_label, storedId, lookups) => {
    const { db, domain, repo } = harness([siteRow(storedId, { tenant_id: TENANT_A })]);

    const detail = await domain.readSite(db, claimsFor('tenant-a'), 'tenant-a');

    expect(detail).toMatchObject({ isNew: 0, site: { SiteID: storedId } });
    expect(repo.matchSite).toHaveBeenCalledTimes(lookups);
    if (lookups > 0) expect(repo.matchSite).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'tenant-a');
    expect(repo.listSites).not.toHaveBeenCalled();
    expect(repo.readSiteExtendDefinitions).toHaveBeenCalledWith(expect.anything(), storedId);
    expect(repo.listImageSizes).toHaveBeenCalledWith(expect.anything(), storedId);
  });

  it('reads no extended values for a stored site without a baseID', async () => {
    const { db, domain, repo, store } = harness([siteRow('tenant-a', { baseid: null })]);
    store.defs = siteDefinitions();
    store.data = [stored(1, 1, 'orphan')];

    const detail = await domain.readSite(db, claimsFor('tenant-a'), 'tenant-a');

    expect(repo.readSiteExtendData).not.toHaveBeenCalled();
    expect(detail.extendSets[0]?.attributes.every((entry) => entry.value === null)).toBe(true);
  });
});

describe('readShellSite', () => {
  const SHELL_FIELDS = Object.keys(
    (OPENAPI as { components: { schemas: { ShellSite: { properties: object } } } }).components.schemas.ShellSite.properties,
  );
  const SENSITIVE = /^(mailserver|recaptcha|googleapikey|contact|filedir|baseid)|script$/i;

  it('denies another site with 403 before opening a transaction', async () => {
    const { db, domain, opened } = harness([siteRow('tenant-b')]);

    await expect(domain.readShellSite(db, claimsFor('tenant-a', false), 'tenant-b')).rejects.toMatchObject({ statusCode: 403 });
    expect(opened).toEqual([]);
  });

  it('projects exactly the layout fields of the stored site, pooled ids and locale as read, and no sensitive field', async () => {
    const { db, domain, repo, opened } = harness([
      siteRow('tenant-a', {
        site: 'Alpha',
        sitelocale: 'German (Standard)',
        theme: 'clean',
        publicuserpoolid: 'umbrella',
        privateuserpoolid: 'umbrella',
        categorypoolid: 'umbrella',
        haschangesets: 1,
        hascomments: 0,
        feedmanager: 1,
        extranet: 1,
        cache: 1,
        showdashboard: 1,
        isremote: 0,
        remoteport: 8080,
        lastdeployment: LAST_DEPLOYMENT,
        mailserverpassword: 'not-for-the-shell',
        recaptchasecret: 'not-for-the-shell',
        contactemail: 'site@example.test',
        sendloginscript: 'script',
      }),
    ]);

    const detail = await domain.readShellSite(db, claimsFor('tenant-a', false), 'tenant-a');

    expect(Object.keys(detail.site).sort()).toEqual([...SHELL_FIELDS].sort());
    expect(Object.keys(detail.site).filter((key) => SENSITIVE.test(key))).toEqual([]);
    expect(detail).toMatchObject({
      isNew: 0,
      site: {
        SiteID: 'tenant-a',
        Site: 'Alpha',
        siteLocale: 'German (Standard)',
        theme: 'clean',
        publicUserPoolID: 'umbrella',
        privateUserPoolID: 'umbrella',
        categoryPoolID: 'umbrella',
        displayPoolID: 'tenant-a',
        contentPoolID: 'tenant-a',
        filePoolID: 'tenant-a',
        hasChangesets: 1,
        hasComments: 0,
        feedManager: 1,
        Extranet: 1,
        Cache: 1,
        showDashboard: 1,
        remoteport: 8080,
        lastDeployment: '2026-01-02T03:04:05.006',
      },
    });
    expect(opened).toEqual([TENANT_A]);
    expect(repo.readSiteExtendDefinitions).not.toHaveBeenCalled();
    expect(repo.readSiteExtendData).not.toHaveBeenCalled();
    expect(repo.listImageSizes).not.toHaveBeenCalled();
    expect(writesOf(repo)).toEqual([]);
    assertContract('GET', '/v1/sites/tenant-a/shell', detail);
  });

  it('reads an unknown id as the defaulted new site with isNew 1', async () => {
    const { db, domain } = harness([]);

    const detail = await domain.readShellSite(db, claimsFor('tenant-a', false), 'tenant-a');

    expect(detail).toMatchObject({
      isNew: 1,
      site: { SiteID: '', publicUserPoolID: '', hasChangesets: 1, hasComments: 1, EmailBroadcaster: 0, lastDeployment: null },
    });
    assertContract('GET', '/v1/sites/tenant-a/shell', detail);
  });

  it.each<{ global: boolean; stored: number | null; expected: number | null }>([
    { global: false, stored: 0, expected: 0 },
    { global: false, stored: 1, expected: 0 },
    { global: false, stored: null, expected: 0 },
    { global: true, stored: 0, expected: 0 },
    { global: true, stored: 1, expected: 1 },
    { global: true, stored: null, expected: null },
  ])('answers EmailBroadcaster $expected for a global broadcaster $global and a stored $stored', async ({ global, stored, expected }) => {
    const config = { emailBroadcaster: global };
    const { db, domain } = harness([siteRow('tenant-a', { emailbroadcaster: stored })], { config });

    const detail = await domain.readShellSite(db, claimsFor('tenant-a', false), 'tenant-a');

    expect(detail.site.EmailBroadcaster).toBe(expected);
    assertContract('GET', '/v1/sites/tenant-a/shell', detail);
  });
});

describe('readUserPoolSites', () => {
  const TENANT_UMBRELLA = tenantIdForSite('umbrella');
  const URL_A = '/v1/sites/tenant-a/user-pool-sites';

  /** The registry entry site.changed stores for `row`: its user pools as stored, an empty one being the site itself. */
  function registryEntry(row: SiteRow): TenantRegistryEntry {
    const pool = (id: string | null): string => (id === null || id === '' ? row.siteid : id);
    const publicUserPoolId = pool(row.publicuserpoolid);
    const privateUserPoolId = pool(row.privateuserpoolid);
    return {
      siteId: row.siteid,
      tenantId: row.tenant_id,
      publicUserPoolId,
      privateUserPoolId,
      categoryPoolId: row.siteid,
      filePoolId: row.siteid,
      displayPoolId: row.siteid,
      contentPoolIds: [row.siteid],
      publicUserPoolTenant: tenantIdForSite(publicUserPoolId),
      privateUserPoolTenant: tenantIdForSite(privateUserPoolId),
      categoryPoolTenant: row.tenant_id,
      filePoolTenant: row.tenant_id,
      displayPoolTenant: row.tenant_id,
      contentPoolTenants: [row.tenant_id],
      domains: [],
      aggregateVersion: 1,
      updatedAt: LAUNCH,
    };
  }

  /** The harness over `rows`, with each row's registry entry readable by tenant. */
  function registered(rows: SiteRow[]): Harness {
    const h = harness(rows);
    vi.mocked(registryEntryForTenant).mockImplementation(async (_db, tenantId) => {
      const row = rows.find((candidate) => candidate.tenant_id === tenantId);
      return row === undefined ? null : registryEntry(row);
    });
    return h;
  }

  it('denies another site with 403 before reading the registry or opening a transaction', async () => {
    const { db, domain, opened } = registered([siteRow('tenant-b')]);

    await expect(domain.readUserPoolSites(db, claimsFor('tenant-a', false), 'tenant-b')).rejects.toMatchObject({ statusCode: 403 });
    expect(registryEntryForTenant).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('reads the private pool, then a public pool of another tenant in that tenant, as layout settings', async () => {
    const { db, domain, repo, opened } = registered([
      siteRow('tenant-a', { publicuserpoolid: 'umbrella' }),
      siteRow('umbrella', { site: 'Umbrella', filepoolid: 'umbrellafiles', isremote: 1, resourcedomain: 'cdn.example.test' }),
    ]);

    const result = await domain.readUserPoolSites(db, claimsFor('tenant-a', false), 'tenant-a');

    expect(result.sites.map(({ SiteID }) => SiteID)).toEqual(['tenant-a', 'umbrella']);
    expect(result.sites[1]).toMatchObject({
      SiteID: 'umbrella',
      Site: 'Umbrella',
      publicUserPoolID: 'umbrella',
      filePoolID: 'umbrellafiles',
      isremote: 1,
      resourceDomain: 'cdn.example.test',
    });
    expect(opened).toEqual([TENANT_A, TENANT_UMBRELLA]);
    expect(writesOf(repo)).toEqual([]);
    assertContract('GET', URL_A, result);
  });

  it('reads a site that is both of its own user pools once', async () => {
    const { db, domain, opened } = registered([siteRow('tenant-a')]);

    const result = await domain.readUserPoolSites(db, claimsFor('tenant-a', false), 'tenant-a');

    expect(result.sites.map(({ SiteID }) => SiteID)).toEqual(['tenant-a']);
    expect(opened).toEqual([TENANT_A]);
    assertContract('GET', URL_A, result);
  });

  it.each<{ name: string; arrange: (h: Harness) => void; sites: string[]; opened: string[] }>([
    {
      name: 'a pool site without a registry entry',
      arrange: ({ store }) => {
        store.registry = store.registry.filter(({ siteId }) => siteId !== 'umbrella');
      },
      sites: ['tenant-a'],
      opened: [TENANT_A],
    },
    {
      name: 'a registered pool site without a stored row',
      arrange: ({ store }) => {
        store.sites.delete(TENANT_UMBRELLA);
      },
      sites: ['tenant-a'],
      opened: [TENANT_A, TENANT_UMBRELLA],
    },
    {
      name: 'every pool of a token site without a registry entry',
      arrange: () => {
        vi.mocked(registryEntryForTenant).mockResolvedValue(null);
      },
      sites: [],
      opened: [],
    },
  ])('leaves out $name', async ({ arrange, sites, opened: expected }) => {
    const h = registered([siteRow('tenant-a', { publicuserpoolid: 'umbrella' }), siteRow('umbrella')]);
    arrange(h);

    const result = await h.domain.readUserPoolSites(h.db, claimsFor('tenant-a', false), 'tenant-a');

    expect(result.sites.map(({ SiteID }) => SiteID)).toEqual(sites);
    expect(h.opened).toEqual(expected);
    assertContract('GET', URL_A, result);
  });
});

describe('readMailSettings', () => {
  const LOOKUP_PATH = '/internal/v1/sites/mail-settings:lookup';
  const rows = (): SiteRow[] => [siteRow('default'), siteRow('tenant-a'), siteRow('tenant-b')];

  it.each<{ name: string; siteId: string; arrange?: (h: Harness) => void; siteID: string; opened: string[] }>([
    { name: 'the named site ignoring case', siteId: 'TENANT-A', siteID: 'tenant-a', opened: [TENANT_A] },
    { name: 'default for an empty id', siteId: '', siteID: 'default', opened: [TENANT_DEFAULT] },
    { name: 'default for an id that names no site', siteId: 'nosuch', siteID: 'default', opened: [TENANT_DEFAULT] },
    {
      name: 'default for a registered site without a stored row',
      siteId: 'tenant-b',
      arrange: ({ store }) => {
        store.sites.delete(TENANT_B);
      },
      siteID: 'default',
      opened: [TENANT_B, TENANT_DEFAULT],
    },
  ])('resolves $name as getSite does', async ({ siteId, arrange, siteID, opened }) => {
    const h = harness(rows());
    arrange?.(h);

    const [settings] = await h.domain.readMailSettings(h.db, [siteId]);

    expect(settings?.siteID).toBe(siteID);
    expect(settings?.site).toBe(`Site ${siteID}`);
    expect(h.opened).toEqual(opened);
    expect(writesOf(h.repo)).toEqual([]);
  });

  it('answers one entry per listed id, in request order', async () => {
    const { db, domain } = harness(rows());

    const items = await domain.readMailSettings(db, ['tenant-b', '', 'tenant-a', 'tenant-b']);

    expect(items.map(({ siteID }) => siteID)).toEqual(['tenant-b', 'default', 'tenant-a', 'tenant-b']);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: LOOKUP_PATH, status: 200, contentType: 'application/json', body: { items } });
  });

  it.each<{ name: string; row: Partial<SiteRow>; indexFile?: string; expected: Record<string, unknown> }>([
    {
      name: 'the stored mail fields of a local site, which keeps configBean port and context',
      row: {
        site: 'Alpha',
        contact: 'contact@a.example.test',
        sendloginscript: 'Dear #firstName#',
        editprofileurl: '/profile/',
        extranetpublicregnotify: 'notify@a.example.test',
        isremote: 0,
        remoteport: 8443,
        remotecontext: '/remote',
      },
      expected: {
        siteID: 'tenant-a',
        site: 'Alpha',
        contact: 'contact@a.example.test',
        sendLoginScript: 'Dear #firstName#',
        editProfileURL: '/profile/',
        extranetSSL: false,
        useSSL: false,
        extranetPublicRegNotify: 'notify@a.example.test',
        remote: null,
      },
    },
    { name: 'the port and context of a remote site', row: { isremote: 1, remoteport: 8443, remotecontext: '/remote' }, expected: { remote: { serverPort: ':8443', context: '/remote' } } },
    { name: 'no port for a remote site on 443', row: { isremote: 1, remoteport: 443, remotecontext: null }, expected: { remote: { serverPort: '', context: '' } } },
    { name: 'the default edit-profile URL for an empty one', row: { editprofileurl: null }, expected: { editProfileURL: '?display=editProfile' } },
    { name: 'the default edit-profile URL under the indexFile', row: { editprofileurl: '' }, indexFile: '/index.cfm', expected: { editProfileURL: '/index.cfm?display=editProfile' } },
    { name: 'null for an edit-profile URL with an [m] tag', row: { editprofileurl: '[m]$.siteConfig("editProfileURL")[/m]' }, expected: { editProfileURL: null } },
    { name: 'null for an edit-profile URL with a [mura] tag', row: { editprofileurl: '/x/[MURA]$.createHref()[/MURA]' }, expected: { editProfileURL: null } },
    { name: 'useSSL and extranetSSL from a set useSSL', row: { usessl: 1, extranetssl: 0 }, expected: { extranetSSL: true, useSSL: true } },
    { name: 'useSSL from extranetSSL when useSSL is NULL', row: { usessl: null, extranetssl: 1 }, expected: { extranetSSL: true, useSSL: true } },
  ])('reads $name', async ({ row, indexFile, expected }) => {
    const config = indexFile === undefined ? {} : { config: { emailBroadcaster: false, indexFile } };
    const { db, domain } = harness([siteRow('tenant-a', row)], config);

    const [settings] = await domain.readMailSettings(db, ['tenant-a']);

    expect(settings).toMatchObject(expected);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: LOOKUP_PATH, status: 200, contentType: 'application/json', body: { items: [settings] } });
  });

  it('fails as getSite does when neither the named site nor default is stored', async () => {
    const { db, domain } = harness([siteRow('tenant-a')]);

    await expect(domain.readMailSettings(db, ['nosuch'])).rejects.toThrow("Neither site 'nosuch' nor the default site is registered");
  });
});

describe('readFeedSettings', () => {
  const LOOKUP_PATH = '/internal/v1/sites/feed-settings:lookup';

  it('answers one entry per listed id in request order, resolving an empty or unknown id to default as getSite does', async () => {
    const { db, domain, opened } = harness([siteRow('default'), siteRow('tenant-a'), siteRow('tenant-b')]);

    const items = await domain.readFeedSettings(db, ['TENANT-B', '', 'nosuch', 'tenant-a']);

    expect(items.map(({ siteID }) => siteID)).toEqual(['tenant-b', 'default', 'default', 'tenant-a']);
    expect(opened).toEqual([TENANT_B, TENANT_DEFAULT, TENANT_DEFAULT, TENANT_A]);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: LOOKUP_PATH, status: 200, contentType: 'application/json', body: { items } });
  });

  it.each<{ name: string; row: Partial<SiteRow>; defaultLocale?: string; expected: Record<string, unknown> }>([
    {
      name: 'the stored contact, domain and aliases of a local site, whose port and context are configBean’s',
      row: {
        contact: 'contact@a.example.test',
        domain: 'a.example.test',
        domainalias: 'alias-1.example.test\r\nalias-2.example.test\n\r\nalias-3.example.test\r\n',
        enforceprimarydomain: 1,
        sitelocale: 'English (UK)',
        isremote: 0,
        remoteport: 8443,
        remotecontext: '/remote',
      },
      expected: {
        siteID: 'tenant-a',
        contact: 'contact@a.example.test',
        javaLocale: 'en_GB',
        domain: 'a.example.test',
        domainAliases: ['alias-1.example.test', 'alias-2.example.test', 'alias-3.example.test'],
        enforcePrimaryDomain: true,
        useSSL: false,
        remote: null,
      },
    },
    { name: 'no aliases, no enforced domain and an empty contact from NULL columns', row: { contact: null, domainalias: null, enforceprimarydomain: null }, expected: { contact: '', domainAliases: [], enforcePrimaryDomain: false } },
    { name: 'the JVM locale of configBean’s default `Server` for a site without a locale', row: { sitelocale: null }, expected: { javaLocale: 'en_US' } },
    { name: 'configBean’s default locale for a site without a locale', row: { sitelocale: '' }, defaultLocale: 'German (Standard)', expected: { javaLocale: 'de_DE' } },
    { name: 'a Java locale name kept as it is', row: { sitelocale: 'fr_CA' }, defaultLocale: 'German (Standard)', expected: { javaLocale: 'fr_CA' } },
    { name: 'the port and context of a remote site', row: { isremote: 1, remoteport: 8443, remotecontext: '/remote' }, expected: { remote: { serverPort: ':8443', context: '/remote' } } },
    { name: 'useSSL from extranetSSL when useSSL is NULL', row: { usessl: null, extranetssl: 1 }, expected: { useSSL: true } },
    { name: 'no SSL when a stored useSSL 0 clears extranetSSL, as its setter does', row: { usessl: 0, extranetssl: 1 }, expected: { useSSL: false } },
  ])('reads $name', async ({ row, defaultLocale, expected }) => {
    const config = defaultLocale === undefined ? {} : { config: { emailBroadcaster: false, defaultLocale } };
    const { db, domain, repo } = harness([siteRow('tenant-a', row)], config);

    const [settings] = await domain.readFeedSettings(db, ['tenant-a']);

    expect(settings).toMatchObject(expected);
    expect(writesOf(repo)).toEqual([]);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: LOOKUP_PATH, status: 200, contentType: 'application/json', body: { items: [settings] } });
  });
});

describe('readConfigFlags', () => {
  const LOOKUP_PATH = '/internal/v1/sites/config-flags:lookup';
  const STORED = { haslockablenodes: 0, haschangesets: 1, datacollection: 1, hascomments: 1, scaffolding: 1, feedmanager: 1 } as const;

  it('answers one entry per listed id in request order, resolving an empty or unknown id to default as getSite does', async () => {
    const { db, domain, opened, repo } = harness([siteRow('default', STORED), siteRow('tenant-a', STORED), siteRow('tenant-b', STORED)]);

    const items = await domain.readConfigFlags(db, ['TENANT-B', '', 'nosuch', 'tenant-a']);

    expect(items.map(({ siteID }) => siteID)).toEqual(['tenant-b', 'default', 'default', 'tenant-a']);
    expect(opened).toEqual([TENANT_B, TENANT_DEFAULT, TENANT_DEFAULT, TENANT_A]);
    expect(writesOf(repo)).toEqual([]);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: LOOKUP_PATH, status: 200, contentType: 'application/json', body: { items } });
  });

  it.each<{ name: string; row: Partial<SiteRow>; dataCollection?: boolean; expected: Record<string, unknown> }>([
    {
      name: 'the stored flags of tenant-a, scaffolding on',
      row: STORED,
      expected: { siteID: 'tenant-a', hasLockableNodes: 0, hasChangesets: 1, dataCollection: 1, hasComments: 1, scaffolding: 1, hasFeedManager: 1 },
    },
    {
      name: 'every stored flag turned the other way',
      row: { haslockablenodes: 1, haschangesets: 0, datacollection: 0, hascomments: 0, scaffolding: 0, feedmanager: 0 },
      expected: { hasLockableNodes: 1, hasChangesets: 0, dataCollection: 0, hasComments: 0, scaffolding: 0, hasFeedManager: 0 },
    },
    {
      name: 'the numeric setters’ defaults and null for the setter-less flags over NULL columns',
      row: { haslockablenodes: null, haschangesets: null, datacollection: null, hascomments: null, scaffolding: null, feedmanager: null },
      expected: { hasLockableNodes: 0, hasChangesets: null, dataCollection: null, hasComments: 1, scaffolding: 1, hasFeedManager: null },
    },
    { name: 'dataCollection 0 while configBean’s is off', row: STORED, dataCollection: false, expected: { dataCollection: 0, hasChangesets: 1 } },
  ])('reads $name', async ({ row, dataCollection, expected }) => {
    const config = dataCollection === undefined ? {} : { config: { emailBroadcaster: false, dataCollection } };
    const { db, domain } = harness([siteRow('tenant-a', row)], config);

    const [flags] = await domain.readConfigFlags(db, ['tenant-a']);

    expect(flags).toMatchObject(expected);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: LOOKUP_PATH, status: 200, contentType: 'application/json', body: { items: [flags] } });
  });
});


describe('readJsonApiValues', () => {
  const LOOKUP_PATH = '/internal/v1/sites/json-api-values:lookup';
  const BASE_URL = 'http://localhost/index.cfm/_api/json/v1/tenant-a';
  const linksOf = (siteId: string): Record<string, string> => ({
    entities: BASE_URL,
    all: `${BASE_URL}/site`,
    properties: `${BASE_URL}/site/properties`,
    self: `${BASE_URL}/site`,
    permissions: `${BASE_URL}/site/${siteId}/permissions`,
  });

  it('answers findOne(site) values per listed id in order, each keeping its spelling, in its registered tenant', async () => {
    const { db, domain, opened, repo } = harness([siteRow('tenant-a'), siteRow('tenant-b')]);

    const items = await domain.readJsonApiValues(db, BASE_URL, ['TENANT-A', 'tenant-b']);

    expect(items).toEqual([
      { links: linksOf('TENANT-A'), domain: 'tenant-a.example.test', siteid: 'TENANT-A', isnew: 0, id: 'TENANT-A', entityname: 'site' },
      { links: linksOf('tenant-b'), domain: 'tenant-b.example.test', siteid: 'tenant-b', isnew: 0, id: 'tenant-b', entityname: 'site' },
    ]);
    expect(opened).toEqual([TENANT_A, TENANT_B]);
    expect(writesOf(repo)).toEqual([]);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: LOOKUP_PATH, status: 200, contentType: 'application/json', body: { items } });
  });

  it('answers the new bean, without a read, for an id no registered site holds', async () => {
    const { db, domain, opened } = harness([siteRow('tenant-a')]);

    const [values] = await domain.readJsonApiValues(db, BASE_URL, ['nosuch']);

    expect(values).toEqual({ links: linksOf('nosuch'), domain: '', siteid: 'nosuch', isnew: 1, id: 'nosuch', entityname: 'site' });
    expect(opened).toEqual([]);
  });
});

describe('saveOrderAndDeploy', () => {
  const rows = (): SiteRow[] => [siteRow('tenant-a', { orderno: 1, deploy: 1 }), siteRow('tenant-b', { orderno: 2, deploy: 1 })];

  it('denies a non-S2 token with 403 before any read or write', async () => {
    const { db, domain, opened, repo } = harness(rows());

    await expect(domain.saveOrderAndDeploy(db, claimsFor('tenant-a', false), { orderID: 'tenant-a', orderno: '1' })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(opened).toEqual([]);
    expect(tenantForRegisteredSite).not.toHaveBeenCalled();
    expect(writesOf(repo)).toEqual([]);
  });

  it('saves each listed site in its own tenant transaction, announces it, then lists the sites in the posted sort', async () => {
    const { db, domain, opened, repo } = harness(rows());

    const result = await domain.saveOrderAndDeploy(db, claimsFor('default'), {
      orderID: 'tenant-b,TENANT-A',
      orderno: '1,2',
      deploy: '0,1',
      sortBy: 'orderno',
    });

    expect(repo.updateOrderNo.mock.calls.map(([tx, siteId, orderno]) => [tx.tenantId, siteId, orderno])).toEqual([
      [TENANT_B, 'tenant-b', 1],
      [TENANT_A, 'tenant-a', 2],
    ]);
    expect(repo.updateDeploy.mock.calls.map(([tx, siteId, deploy]) => [tx.tenantId, siteId, deploy])).toEqual([
      [TENANT_B, 'tenant-b', 0],
      [TENANT_A, 'tenant-a', 1],
    ]);
    expect(announced()).toEqual([
      { tenantId: TENANT_B, siteId: 'tenant-b', rowVersion: 3n, origin: undefined },
      { tenantId: TENANT_A, siteId: 'tenant-a', rowVersion: 3n, origin: undefined },
    ]);
    const payload = vi.mocked(writeSiteChanged).mock.calls[0]?.[1].payload;
    expect(payload).toMatchObject({ siteId: 'tenant-b', publicUserPoolId: 'tenant-b', domains: ['tenant-b.example.test'] });
    expect(siteChangedValidator.validatePayload(payload)).toMatchObject({ ok: true });
    expect(opened).toEqual([TENANT_B, TENANT_A, TENANT_A, TENANT_B]);
    expect(result).toEqual({
      written: true,
      sites: [
        expect.objectContaining({ siteid: 'tenant-b', orderno: 1, deploy: 0 }),
        expect.objectContaining({ siteid: 'tenant-a', orderno: 2, deploy: 1 }),
      ],
    });
    assertContract('POST', '/v1/sites/order', result);
  });

  it('saves no deploy flags when the deploy list is empty', async () => {
    const { db, domain, repo } = harness(rows());

    await domain.saveOrderAndDeploy(db, claimsFor('default'), { orderID: 'tenant-a', orderno: '5', deploy: '' });

    expect(repo.updateOrderNo).toHaveBeenCalledOnce();
    expect(repo.updateDeploy).not.toHaveBeenCalled();
    expect(announced()).toEqual([{ tenantId: TENANT_A, siteId: 'tenant-a', rowVersion: 2n, origin: undefined }]);
  });

  it('skips listed sites that are unregistered or have no stored row', async () => {
    const { db, domain, repo, store, opened } = harness(rows());
    store.registry.push({ siteId: 'tenant-c', tenantId: tenantIdForSite('tenant-c') });

    const result = await domain.saveOrderAndDeploy(db, claimsFor('default'), { orderID: 'ghost,tenant-c', orderno: '1,2', deploy: '1,1' });

    expect(writesOf(repo)).toEqual([]);
    expect(announced()).toEqual([]);
    expect(opened[0]).toBe(tenantIdForSite('tenant-c'));
    expect(result.sites.map((site) => site.siteid)).toEqual(['tenant-a', 'tenant-b']);
  });

  it('drops empty list items as CFML lists do and truncates numeric text', async () => {
    const { db, domain, repo } = harness(rows());

    await domain.saveOrderAndDeploy(db, claimsFor('default'), { orderID: ',tenant-a,,', orderno: ',2.9,', deploy: '1,' });

    expect(repo.updateOrderNo).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'tenant-a', 2);
    expect(repo.updateDeploy).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'tenant-a', 1);
  });

  it('writes nothing for an empty or absent site list and still lists the sites', async () => {
    const { db, domain, repo } = harness(rows());

    expect((await domain.saveOrderAndDeploy(db, claimsFor('default'), { orderno: '1', deploy: '1' })).sites).toHaveLength(2);
    expect((await domain.saveOrderAndDeploy(db, claimsFor('default'), { orderID: '' })).written).toBe(true);
    expect(writesOf(repo)).toEqual([]);
  });

  it.each<{ name: string; orderno: string; deploy: string; message: string }>([
    { name: 'a short order list', orderno: '1', deploy: '', message: 'Invalid orderno list: element 2 is not a number' },
    { name: 'a non-numeric order', orderno: '1,x', deploy: '', message: 'Invalid orderno list: element 2 is not a number' },
    { name: 'a short deploy list', orderno: '1,2', deploy: '1', message: 'Invalid deploy list: element 2 is not a number' },
  ])('fails like listGetAt on $name after committing the sites before it', async ({ orderno, deploy, message }) => {
    const { db, domain, repo } = harness(rows());

    await expect(domain.saveOrderAndDeploy(db, claimsFor('default'), { orderID: 'tenant-a,tenant-b', orderno, deploy })).rejects.toThrow(message);
    expect(repo.updateOrderNo.mock.calls.map(([, siteId]) => siteId)[0]).toBe('tenant-a');
    expect(announced().map((event) => event.siteId)).toEqual(['tenant-a']);
  });

  it.each<{ name: string; deploy: string; vanishing: 'updateOrderNo' | 'updateDeploy' }>([
    { name: 'its order write', deploy: '', vanishing: 'updateOrderNo' },
    { name: 'its deploy write', deploy: '1', vanishing: 'updateDeploy' },
  ])('fails when the site vanishes at $name and announces nothing', async ({ deploy, vanishing }) => {
    const { db, domain, repo } = harness(rows());
    repo[vanishing].mockResolvedValueOnce(null);

    await expect(domain.saveOrderAndDeploy(db, claimsFor('default'), { orderID: 'tenant-a', orderno: '3', deploy })).rejects.toThrow(
      'Site tenant-a disappeared inside its own order transaction',
    );
    expect(announced()).toEqual([]);
  });
});

describe('emitStateEvents', () => {
  const write: WriteContext = { origin: 'migration-feed', operationId: 'OP1' };

  function change(overrides: Partial<AppliedChange> = {}): AppliedChange {
    return { unit: SITE.unit, table: SITE.table, op: 'update', after: { siteid: 'tenant-a', row_version: '41' }, origin: 'migration-feed', tenantId: TENANT_A, ...overrides };
  }

  it.each<{ name: string; applied: AppliedChange }>([
    { name: 'another unit', applied: change({ unit: 'programs_sites.image_size', table: 'image_size' }) },
    { name: 'a delete without its row', applied: change({ op: 'delete', before: undefined, after: undefined }) },
    { name: 'an insert without its row', applied: change({ op: 'insert', after: undefined }) },
  ])('ignores $name', async ({ applied }) => {
    const { domain, repo } = harness([siteRow('tenant-a')]);

    await domain.emitStateEvents(tenantTx(TENANT_A), applied, write);

    expect(writesOf(repo)).toEqual([]);
    expect(announced()).toEqual([]);
  });

  it.each<{ last: bigint; rowVersion: bigint }>([
    { last: 0n, rowVersion: 42n },
    { last: 41n, rowVersion: 42n },
    { last: 60n, rowVersion: 61n },
  ])('announces a deleted site as its last state marked deleted at $rowVersion after announced version $last', async ({ last, rowVersion }) => {
    const { domain, repo } = harness([]);
    const tx = tenantTx(TENANT_A);
    const removed = siteRow('tenant-a', { row_version: '41', publicuserpoolid: 'umbrella' });
    vi.mocked(lastAnnouncedVersion).mockResolvedValueOnce(last);

    await domain.emitStateEvents(tx, change({ op: 'delete', before: removed, after: undefined, origin: 'legacy-window' }), write);

    expect(writesOf(repo)).toEqual([]);
    expect(lastAnnouncedVersion).toHaveBeenCalledExactlyOnceWith(tx, 'tenant-a');
    const payload = { ...siteChangedPayload(removed), deleted: true };
    expect(writeSiteChanged).toHaveBeenCalledExactlyOnceWith(tx, { siteId: 'tenant-a', rowVersion, payload, origin: 'legacy-window' });
    expect(siteChangedValidator.validatePayload(payload)).toStrictEqual({ ok: true, value: payload });
  });

  it.each(['insert', 'update'] as const)('announces an applied site %s at the row version it was written with, writing nothing more', async (op) => {
    const { domain, repo } = harness([siteRow('tenant-a', { row_version: '42' })]);
    const tx = tenantTx(TENANT_A);

    await domain.emitStateEvents(tx, change({ op, origin: 'backfill', after: { siteid: 'tenant-a', row_version: '42' } }), write);

    expect(writesOf(repo)).toEqual([]);
    expect(announced()).toEqual([{ tenantId: TENANT_A, siteId: 'tenant-a', rowVersion: 42n, origin: 'backfill' }]);
    expect(vi.mocked(writeSiteChanged).mock.calls[0]?.[0]).toBe(tx);
  });
});

describe('targetOnlyColumns', () => {
  const write: WriteContext = { origin: 'migration-feed' };

  it.each<{ name: string; before: Record<string, unknown> | undefined; unit: string; expected: Record<string, unknown> }>([
    { name: 'a new site at row version 1', before: undefined, unit: SITE.unit, expected: { row_version: '1' } },
    { name: 'a changed site one past its stored row version', before: { siteid: 'tenant-a', row_version: '41' }, unit: SITE.unit, expected: { row_version: '42' } },
    { name: 'nothing for another unit', before: undefined, unit: 'programs_sites.image_size', expected: {} },
  ])('writes $name', async ({ before, unit, expected }) => {
    const { domain, repo } = harness([]);
    const pending = { unit, table: 'site', row: { siteid: 'tenant-a' }, ...(before === undefined ? {} : { before }) };

    expect(await domain.targetOnlyColumns(tenantTx(TENANT_A), pending, write)).toEqual(expected);
    expect(writesOf(repo)).toEqual([]);
  });

  it.each<{ name: string; before: Record<string, unknown> | undefined; last: bigint; rowVersion: string; reads: boolean }>([
    { name: 'a site created again', before: undefined, last: 60n, rowVersion: '61', reads: true },
    { name: 'a new site', before: undefined, last: 0n, rowVersion: '1', reads: true },
    { name: 'a changed site', before: { siteid: 'tenant-a', row_version: '41' }, last: 60n, rowVersion: '42', reads: false },
  ])('writes $name after announced version $last at row version $rowVersion', async ({ before, last, rowVersion, reads }) => {
    const { domain, repo } = harness([]);
    const tx = tenantTx(TENANT_A);
    vi.mocked(lastAnnouncedVersion).mockResolvedValue(last);
    const pending = { unit: SITE.unit, table: 'site', row: { siteid: 'tenant-a' }, ...(before === undefined ? {} : { before }) };

    expect(await domain.targetOnlyColumns(tx, pending, write)).toEqual({ row_version: rowVersion });
    expect(vi.mocked(lastAnnouncedVersion).mock.calls).toEqual(reads ? [[tx, 'tenant-a']] : []);
    expect(writesOf(repo)).toEqual([]);
  });
});
