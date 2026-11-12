/** Site operations of csettings list, editSite, updateSite{action=Update} and the order form over recording fakes of the tenant database, repository and site.changed writer. */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { AppliedChange, WriteContext } from '@opt2/platform/migration-kit';
import { registeredTenants, tenantForRegisteredSite, tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { createSitesDomain, extendDataRows, fileAttributeBranches, type SitesDomainDeps } from '../../src/domain/sites.js';
import { siteChangedValidator } from '../../src/events/consumers.js';
import { writeSiteChanged } from '../../src/events/site-changed.js';
import { SITE_COLUMNS } from '../../src/legacy/site-fields.js';
import { SITE_ERROR_INVALID, SITE_ERROR_REQUIRED } from '../../src/legacy/validation.js';
import type { ProgramsSitesRepository, SiteExtendDataReplacement, SiteExtendDefinitions } from '../../src/repo/repository.js';
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
  return { ...actual, registeredTenants: vi.fn(), tenantForRegisteredSite: vi.fn() };
});

vi.mock('../../src/events/site-changed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/events/site-changed.js')>();
  return { ...actual, writeSiteChanged: vi.fn() };
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
const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

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
    listSites: vi.fn(async (tx: TenantTx) => [...rowsOf(tx)]),
    readSiteExtendDefinitions: vi.fn(async (_tx: TenantTx, _siteId: string) => store.defs),
    readSiteExtendData: vi.fn(async (_tx: TenantTx, baseId: string) => store.data.filter((row) => row.baseid === baseId)),
    listImageSizes: vi.fn(async (_tx: TenantTx, siteId: string) => store.imageSizes.filter((row) => row.siteid === siteId)),
    updateSiteRow: vi.fn(async (tx: TenantTx, before: SiteRow, after: Readonly<Record<string, unknown>>, _ctx?: WriteContext) =>
      replace(tx, before.siteid, after, true),
    ),
    updateOrderNo: vi.fn(async (tx: TenantTx, siteId: string, orderno: number) => replace(tx, siteId, { orderno }, true)),
    updateDeploy: vi.fn(async (tx: TenantTx, siteId: string, deploy: number) => replace(tx, siteId, { deploy }, true)),
    replaceSiteExtendData: vi.fn(async (_tx: TenantTx, _replacement: SiteExtendDataReplacement, _ctx?: WriteContext) => null),
    update: vi.fn(async (tx: TenantTx, _table: string, key: Readonly<Record<string, unknown>>, patch: Readonly<Record<string, unknown>>, _ctx?: WriteContext) =>
      replace(tx, String(key.siteid), patch, false),
    ),
  };
}

type FakeRepo = ReturnType<typeof fakeRepo>;

const WRITE_METHODS = ['updateSiteRow', 'updateOrderNo', 'updateDeploy', 'replaceSiteExtendData', 'update'] as const;

function tenantTx(tenantId: string): TenantTx {
  const reject = (): Promise<never> => Promise.reject(new Error('SQL issued against the fake transaction'));
  return { kind: 'tenant', tenantId, schema: 'programs_sites', query: reject, onCommit: vi.fn() };
}

interface Harness {
  db: TenantDb;
  repo: FakeRepo;
  store: Store;
  opened: string[];
  domain: ReturnType<typeof createSitesDomain>;
}

function harness(rows: SiteRow[] = [], deps: Omit<SitesDomainDeps, 'repo'> = {}): Harness {
  const store = newStore(rows);
  const repo = fakeRepo(store);
  const opened: string[] = [];
  const db: TenantDb = {
    schema: 'programs_sites',
    withTenant: (tenantId, fn) => {
      opened.push(tenantId);
      return fn(tenantTx(tenantId));
    },
    withMetadata: () => Promise.reject(new Error('metadata transaction opened')),
    end: () => Promise.resolve(),
  };
  vi.mocked(registeredTenants).mockImplementation(async () =>
    [...store.registry].sort((a, b) => a.siteId.localeCompare(b.siteId)),
  );
  vi.mocked(tenantForRegisteredSite).mockImplementation(
    async (_db, siteId) => store.registry.find((entry) => entry.siteId.toLowerCase() === siteId.toLowerCase())?.tenantId ?? null,
  );
  const domain = createSitesDomain({ repo: repo as unknown as ProgramsSitesRepository, ...deps });
  return { db, repo, store, opened, domain };
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

function replacements(repo: FakeRepo): SiteExtendDataReplacement[] {
  return repo.replaceSiteExtendData.mock.calls.map(([, replacement]) => replacement);
}

function updatedColumns(repo: FakeRepo): Readonly<Record<string, unknown>> {
  const call = repo.updateSiteRow.mock.calls[0];
  if (call === undefined) throw new Error('updateSiteRow was not called');
  return call[2];
}

function assertContract(method: string, path: string, body: unknown): void {
  assertResponseMatchesOpenApi(OPENAPI, { method, path, status: 200, contentType: 'application/json', body });
}

beforeEach(() => {
  vi.mocked(writeSiteChanged).mockReset().mockResolvedValue(null);
  vi.mocked(registeredTenants).mockReset();
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
    const { db, domain, opened } = harness(rows());

    const sites = await domain.listSites(db, claimsFor('default'), { sortBy, sortDirection });

    expect(sites.map((site) => site.siteid)).toEqual(expected);
    expect(opened).toEqual([TENANT_DEFAULT, TENANT_A, TENANT_B]);
    expect(registeredTenants).toHaveBeenCalledExactlyOnceWith(db);
  });

  it('lists only the token tenant for a non-S2 token without reading the registry', async () => {
    const { db, domain, opened } = harness(rows());

    const sites = await domain.listSites(db, claimsFor('tenant-a', false));

    expect(sites.map((site) => site.siteid)).toEqual(['tenant-a']);
    expect(opened).toEqual([TENANT_A]);
    expect(registeredTenants).not.toHaveBeenCalled();
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

  it('finds a stored id that differs in case and reads its parts under the stored id', async () => {
    const { db, domain, repo } = harness([siteRow('Tenant-A', { tenant_id: TENANT_A })]);

    const detail = await domain.readSite(db, claimsFor('tenant-a'), 'tenant-a');

    expect(detail).toMatchObject({ isNew: 0, site: { SiteID: 'Tenant-A' } });
    expect(repo.listSites).toHaveBeenCalledOnce();
    expect(repo.readSiteExtendDefinitions).toHaveBeenCalledWith(expect.anything(), 'Tenant-A');
    expect(repo.listImageSizes).toHaveBeenCalledWith(expect.anything(), 'Tenant-A');
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
    const config = { emailBroadcaster: global, dataCollection: true, indexFile: '' };
    const { db, domain } = harness([siteRow('tenant-a', { emailbroadcaster: stored })], { config });

    const detail = await domain.readShellSite(db, claimsFor('tenant-a', false), 'tenant-a');

    expect(detail.site.EmailBroadcaster).toBe(expected);
    assertContract('GET', '/v1/sites/tenant-a/shell', detail);
  });
});

describe('updateSite', () => {
  it.each<{ path: string; posted: string }>([
    { path: 'tenant-b', posted: 'tenant-a' },
    { path: 'tenant-a', posted: 'tenant-b' },
  ])('denies path $path with posted siteid $posted with 403 before opening a transaction', async ({ path, posted }) => {
    const { db, domain, opened, repo } = harness([siteRow('tenant-a'), siteRow('tenant-b')]);

    await expect(domain.updateSite(db, claimsFor('tenant-a'), path, { siteid: posted })).rejects.toMatchObject({ statusCode: 403 });
    expect(opened).toEqual([]);
    expect(writesOf(repo)).toEqual([]);
  });

  it.each<{ name: string; extra: Record<string, unknown> }>([
    { name: 'without extendSetID', extra: {} },
    { name: 'with an empty extendSetID', extra: { extendSetID: '' } },
  ])('saves the posted fields through the setter guards, advances the row and announces it $name', async ({ extra }) => {
    const { db, domain, repo, opened } = harness([
      siteRow('tenant-a', { largeimagewidth: '600', cachefreememorythreshold: 60, emailbroadcaster: 1 }),
    ]);
    const write: WriteContext = { actorUserId: 'U1', requestId: 'R1' };

    const result = await domain.updateSite(
      db,
      claimsFor('tenant-a'),
      'tenant-a',
      {
        SiteID: 'tenant-a',
        site: 'Renamed',
        domain: ' a.example.test ',
        tagline: 'Hi',
        publicUserPoolID: '',
        contentPoolID: 'tenant-a,default',
        largeImageWidth: 'abc',
        cacheFreeMemoryThreshold: '0',
        useSSL: 'yes',
        ...extra,
      },
      { write },
    );

    expect(opened).toEqual([TENANT_A]);
    expect(repo.updateSiteRow).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ siteid: 'tenant-a' }), expect.any(Object), write);
    expect(updatedColumns(repo)).toMatchObject({
      site: 'Renamed',
      domain: 'a.example.test',
      tagline: 'Hi',
      publicuserpoolid: 'tenant-a',
      contentpoolid: 'tenant-a,default',
      largeimagewidth: '600',
      cachefreememorythreshold: '60',
      usessl: '1',
      extranetssl: '1',
      emailbroadcaster: '0',
      loginurl: '?display=login',
      editprofileurl: '?display=editProfile',
    });
    expect(repo.readSiteExtendDefinitions).not.toHaveBeenCalled();
    expect(repo.replaceSiteExtendData).not.toHaveBeenCalled();
    expect(announced()).toEqual([{ tenantId: TENANT_A, siteId: 'tenant-a', rowVersion: 2n, origin: undefined }]);
    const payload = vi.mocked(writeSiteChanged).mock.calls[0]?.[1].payload;
    expect(payload).toMatchObject({ siteId: 'tenant-a', publicUserPoolId: 'tenant-a', contentPoolIds: ['tenant-a', 'default'], domains: ['a.example.test'] });
    expect(siteChangedValidator.validatePayload(payload)).toMatchObject({ ok: true });
    expect(result).toMatchObject({ written: true, errors: {}, site: { SiteID: 'tenant-a', Site: 'Renamed', largeImageWidth: '600' } });
    assertContract('POST', '/v1/sites/tenant-a/update', result);
  });

  it('resolves the effective broadcaster, data collection and login URLs from the global config', async () => {
    const config = { emailBroadcaster: true, dataCollection: false, indexFile: '/index.cfm' };
    const { db, domain, repo } = harness([siteRow('tenant-a', { emailbroadcaster: 1, datacollection: 1 })], { config });

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a' });

    expect(updatedColumns(repo)).toMatchObject({
      emailbroadcaster: '1',
      datacollection: '0',
      loginurl: '/index.cfm?display=login',
      editprofileurl: '/index.cfm?display=editProfile',
    });
  });

  it('stores the init baseID for a stored row without one', async () => {
    const { db, domain, repo } = harness([siteRow('tenant-a', { baseid: null })]);

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a' });

    expect(updatedColumns(repo).baseid).toMatch(CF_UUID);
  });

  it('answers the required-siteid error and writes nothing when no siteid is posted', async () => {
    const { db, domain, repo } = harness([siteRow('tenant-a')]);

    const result = await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { site: 'Nameless' });

    expect(result).toMatchObject({ written: true, errors: { siteid: SITE_ERROR_REQUIRED }, site: { SiteID: '', Site: 'Nameless' } });
    expect(writesOf(repo)).toEqual([]);
    expect(announced()).toEqual([]);
    assertContract('POST', '/v1/sites/tenant-a/update', result);
  });

  it('answers an unknown posted site with its posted values and no errors, writing nothing', async () => {
    const { db, domain, repo } = harness([]);

    const result = await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', site: 'New', pagelimit: 'abc', archiveDate: 'soon', tagline: { text: 'x' } });

    expect(result).toMatchObject({
      written: true,
      errors: {},
      site: { SiteID: 'tenant-a', Site: 'New', publicUserPoolID: 'tenant-a', PageLimit: null, archiveDate: null, tagline: null },
    });
    expect(result.site.baseID).toMatch(CF_UUID);
    expect(writesOf(repo)).toEqual([]);
    expect(announced()).toEqual([]);
  });

  it('answers the invalid-siteid error of a stored reserved site before any branch check, writing nothing', async () => {
    const { db, domain, repo } = harness([siteRow('admin')]);

    const result = await domain.updateSite(db, claimsFor('admin'), 'admin', { siteid: 'admin', bundleFile: 'site.zip' });

    expect(result).toMatchObject({ written: true, errors: { siteid: SITE_ERROR_INVALID }, site: { SiteID: 'admin' } });
    expect(writesOf(repo)).toEqual([]);
    expect(announced()).toEqual([]);
  });

  it.each<{ name: string; data: Record<string, unknown> }>([
    { name: 'a bundle deploy', data: { bundleFile: 'site.zip' } },
    { name: 'a placeholder image', data: { newPlaceholderImg: 'img.png' } },
    { name: 'Razuna settings', data: { hostName: 'dam.example.test', hostID: '1', apiKey: 'k' } },
    { name: 'a switch onto its own display pool', data: { displayPoolID: 'tenant-a' } },
  ])('refuses $name with a legacy 503 and writes nothing', async ({ data }) => {
    const { db, domain, repo } = harness([siteRow('tenant-a', { displaypoolid: 'default' })]);

    const update = domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', ...data });

    await expect(update).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(update).rejects.toMatchObject({ reason: 'foreign-branch' });
    expect(writesOf(repo)).toEqual([]);
    expect(announced()).toEqual([]);
  });

  it('fails when the stored row vanishes inside its update and announces nothing', async () => {
    const { db, domain, repo } = harness([siteRow('tenant-a')]);
    repo.updateSiteRow.mockResolvedValueOnce(null);

    await expect(domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a' })).rejects.toThrow(
      'Site tenant-a disappeared inside its own update transaction',
    );
    expect(announced()).toEqual([]);
  });
});

describe('updateSite extended data', () => {
  function extendHarness(deps: Omit<SitesDomainDeps, 'repo'> = {}): Harness {
    const h = harness([siteRow('tenant-a')], deps);
    h.store.defs = siteDefinitions();
    h.store.data = [stored(7, 2, '3'), stored(8, 2, '4'), stored(9, 3, '2026-03-04 05:06:07', LAUNCH), stored(11, 6, 'kept')];
    return h;
  }

  it('replaces the posted, stored and defaulted values of the posted and auto-completed sets before the site row', async () => {
    const { db, domain, repo } = extendHarness();
    const write: WriteContext = { actorUserId: 'U1' };

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1, ext1: 'blue', size: 'abc' }, { write });

    const written = replacements(repo);
    expect(written.map((entry) => entry.attributeId)).toEqual([1, 2, 3, 6]);
    expect(written).toMatchObject([
      { baseId: BASE_ID, siteId: 'tenant-a', values: { attributevalue: 'blue', stringvalue: 'blue', datetimevalue: null, numericvalue: null, remoteid: '' } },
      { values: { attributevalue: null, stringvalue: '', datetimevalue: null, numericvalue: null } },
      { values: { attributevalue: "{ts '2026-03-04 05:06:07'}", datetimevalue: LAUNCH, numericvalue: null } },
      { values: { attributevalue: 'kept', stringvalue: 'kept' } },
    ]);
    expect(repo.replaceSiteExtendData.mock.calls.every(([, , ctx]) => ctx === write)).toBe(true);
    expect(repo.readSiteExtendDefinitions).toHaveBeenCalledWith(expect.anything(), 'tenant-a');
    expect(repo.readSiteExtendData).toHaveBeenCalledWith(expect.anything(), BASE_ID);
    const order = [...repo.replaceSiteExtendData.mock.invocationCallOrder, ...repo.updateSiteRow.mock.invocationCallOrder];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(announced()).toHaveLength(1);
  });

  it('deletes emptied values without reinserting them and defaults a NULL-stored value when empty values are not saved', async () => {
    const { db, domain, repo, store } = extendHarness({ saveEmptyExtendedValues: false });
    store.data = [stored(7, 2, null)];

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1, ext1: '', launch: '' });

    const [color, ...rest] = replacements(repo);
    expect(color).toMatchObject({ attributeId: 1, values: { attributevalue: 'red' } });
    expect(rest).toEqual([
      { baseId: BASE_ID, siteId: 'tenant-a', attributeId: 2, values: { attributevalue: '5', stringvalue: '5', datetimevalue: null, numericvalue: 5, remoteid: '' } },
      { baseId: BASE_ID, siteId: 'tenant-a', attributeId: 3, values: null },
      { baseId: BASE_ID, siteId: 'tenant-a', attributeId: 6, values: null },
    ]);
  });

  it('auto-completes no set from stored values of unknown or other-site attributes', async () => {
    const { db, domain, repo, store } = extendHarness();
    const foreignSet = 'E0000000-0000-0000-0000000000000009';
    store.defs.attributes.push(attribute(8, 'foreign', { siteid: 'tenant-b', extendsetid: foreignSet }), attribute(9, 'tagline', { extendsetid: foreignSet }));
    store.data = [stored(20, 99, 'unknown'), stored(21, 8, 'foreign')];

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1 });

    expect(replacements(repo).map((entry) => entry.attributeId)).toEqual([1, 2, 3, 6]);
    expect(replacements(repo)).toMatchObject([{ values: { attributevalue: 'red' } }, { values: { numericvalue: 5 } }, { values: { attributevalue: null } }, { values: { attributevalue: null } }]);
  });

  it('keeps a bean field over a stored value of an attribute with the same name', async () => {
    const { db, domain, repo, store } = extendHarness();
    store.defs.attributes = [attribute(1, 'Tagline')];
    store.data = [stored(5, 1, 'stored tagline')];

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1, tagline: 'posted tagline' });

    expect(replacements(repo)).toMatchObject([{ attributeId: 1, values: { attributevalue: 'posted tagline' } }]);
  });

  it.each(['ext5', 'logo', 'extDelete5', 'extDeletelogo'])('refuses a posted File attribute under %s with a legacy 503 and writes nothing', async (key) => {
    const { db, domain, repo } = extendHarness();

    const update = domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1, [key]: 'upload.png' });

    await expect(update).rejects.toMatchObject({ name: 'LegacyServiceUnavailableError', reason: 'foreign-branch' });
    expect(writesOf(repo)).toEqual([]);
    expect(announced()).toEqual([]);
  });

  it.each(['[mura]now()[/mura]', '[m]x[/m]', '[sava]y[/sava]'])('refuses an unstored attribute default %s with a legacy 503 and writes nothing', async (defaultvalue) => {
    const { db, domain, repo, store } = extendHarness();
    store.defs.attributes[0] = attribute(1, 'color', { defaultvalue });

    const update = domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1 });

    await expect(update).rejects.toMatchObject({ name: 'LegacyServiceUnavailableError', reason: 'extend-dynamic-default' });
    expect(writesOf(repo)).toEqual([]);
  });

  // The admin forms post a Date attribute as datepicker text (MM/DD/YYYY) and a DateTime one as {ts '...'} text.
  it.each<{ posted: Record<string, string>; attributevalue: string; datetimevalue: Date }>([
    { posted: { launch: '11/12/2026' }, attributevalue: "{ts '2026-11-12 00:00:00'}", datetimevalue: new Date(2026, 10, 12) },
    { posted: { ext3: "{ts '2026-11-12 10:30:00'}" }, attributevalue: "{ts '2026-11-12 10:30:00'}", datetimevalue: new Date(2026, 10, 12, 10, 30) },
    { posted: { launch: '11/12/2026', siteLocale: 'German (Standard)' }, attributevalue: "{ts '2026-11-12 00:00:00'}", datetimevalue: new Date(2026, 10, 12) },
  ])('reads posted date text $posted in the stored site locale and writes its timestamp', async ({ posted, attributevalue, datetimevalue }) => {
    const { db, domain, repo } = extendHarness();

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1, ...posted });

    expect(replacements(repo).find((entry) => entry.attributeId === 3)?.values).toEqual({ stringvalue: attributevalue, remoteid: '', attributevalue, datetimevalue, numericvalue: null });
    expect(repo.updateSiteRow).toHaveBeenCalledOnce();
  });

  // ACF 2023 under setLocale('de_DE'): lsParseDateTime('12.11.2026') is 2026-11-12.
  it('reads date text in a stored German (Standard) site locale', async () => {
    const { db, domain, repo, store } = extendHarness();
    store.sites.set(TENANT_A, [siteRow('tenant-a', { sitelocale: 'German (Standard)' })]);

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1, launch: '12.11.2026' });

    const attributevalue = "{ts '2026-11-12 00:00:00'}";
    expect(replacements(repo).find((entry) => entry.attributeId === 3)?.values).toEqual({ stringvalue: attributevalue, remoteid: '', attributevalue, datetimevalue: new Date(2026, 10, 12), numericvalue: null });
  });

  it('fails date text when the stored site locale is one setLocale refuses and writes nothing', async () => {
    const { db, domain, repo, store } = extendHarness();
    store.sites.set(TENANT_A, [siteRow('tenant-a', { sitelocale: 'korean (south korea)' })]);

    const update = domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1, launch: '11/12/2026' });

    await expect(update).rejects.toMatchObject({ name: 'Error', message: 'ko_KY must be one of the ColdFusion supported locales.' });
    expect(writesOf(repo)).toEqual([]);
  });

  it('reads date text in the server locale ctx.locale names over a stored German (Standard) site locale', async () => {
    const { db, domain, repo, store } = extendHarness();
    store.sites.set(TENANT_A, [siteRow('tenant-a', { sitelocale: 'German (Standard)' })]);

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1, launch: '11/12/2026' }, { locale: '' });

    const attributevalue = "{ts '2026-11-12 00:00:00'}";
    expect(replacements(repo).find((entry) => entry.attributeId === 3)?.values).toEqual({ stringvalue: attributevalue, remoteid: '', attributevalue, datetimevalue: new Date(2026, 10, 12), numericvalue: null });
    expect(repo.updateSiteRow).toHaveBeenCalledOnce();
  });

  it('fails date text the timestamp binding refuses with a server error and writes nothing', async () => {
    const { db, domain, repo } = extendHarness();

    const update = domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1, launch: 'next week' });

    await expect(update).rejects.toMatchObject({ name: 'Error', message: 'next week is an invalid date or time string.' });
    expect(writesOf(repo)).toEqual([]);
  });

  it('adds no sets and saves nothing when the site has no extend definitions', async () => {
    const { db, domain, repo, store } = extendHarness();
    store.defs = emptyDefinitions();
    store.data = [];

    await domain.updateSite(db, claimsFor('tenant-a'), 'tenant-a', { siteid: 'tenant-a', extendSetID: SET_1 });

    expect(repo.replaceSiteExtendData).not.toHaveBeenCalled();
    expect(repo.updateSiteRow).toHaveBeenCalledOnce();
  });
});

describe('extendDataRows', () => {
  const color = attribute(1, 'color');
  const size = attribute(2, 'size', { validation: 'numeric' });
  const launch = attribute(3, 'launch', { validation: 'DateTime' });
  const options = { saveEmptyExtendedValues: true, siteLocale: '' };

  it('reads ext<attributeID> before the name, case-insensitively, the last matching key winning', () => {
    const rows = extendDataRows(BASE_ID, [color], { SITEID: 'tenant-a', EXT1: '', Color: 'green', color: 'teal' }, options);

    expect(rows).toEqual([
      { baseId: BASE_ID, siteId: 'tenant-a', attributeId: 1, values: { stringvalue: 'teal', remoteid: '', attributevalue: 'teal', datetimevalue: null, numericvalue: null } },
    ]);
  });

  it('leaves attributes posted under neither key, or only as null, untouched', () => {
    expect(extendDataRows(BASE_ID, [color, size], { siteid: 'tenant-a', ext1: null, other: 'x' }, options)).toEqual([]);
  });

  it('writes the remote id cut to 35 characters and the string value cut to 250', () => {
    const long = 'x'.repeat(300);
    const [row] = extendDataRows(BASE_ID, [color], { siteID: 'tenant-a', remoteID: 'R'.repeat(40), ext1: long }, options);

    expect(row?.values).toMatchObject({ remoteid: 'R'.repeat(35), stringvalue: 'x'.repeat(250), attributevalue: long });
  });

  it.each<{ value: unknown; attributevalue: string | null; numericvalue: number | null }>([
    { value: 12.5, attributevalue: '12.5', numericvalue: 12.5 },
    { value: ' 42 ', attributevalue: ' 42 ', numericvalue: 42 },
    { value: '1e3', attributevalue: '1e3', numericvalue: 1000 },
    { value: true, attributevalue: null, numericvalue: null },
    { value: 'abc', attributevalue: null, numericvalue: null },
  ])('writes numeric attribute value $value as $attributevalue with numeric value $numericvalue', ({ value, attributevalue, numericvalue }) => {
    const [row] = extendDataRows(BASE_ID, [size], { siteid: 'tenant-a', ext2: value }, options);

    expect(row?.values).toMatchObject({ attributevalue, numericvalue });
  });

  it.each<{ value: unknown; text: string }>([
    { value: 3, text: '3' },
    { value: 0.1, text: '0.1' },
    { value: false, text: 'false' },
  ])('writes text attribute value $value as $text', ({ value, text }) => {
    const [row] = extendDataRows(BASE_ID, [color], { siteid: 'tenant-a', color: value }, options);

    expect(row?.values).toMatchObject({ attributevalue: text, stringvalue: text, numericvalue: null });
  });

  it('writes a date attribute Date as CFML timestamp text and its datetime value', () => {
    const [row] = extendDataRows(BASE_ID, [launch], { siteid: 'tenant-a', launch: LAUNCH }, options);

    expect(row?.values).toEqual({ stringvalue: "{ts '2026-03-04 05:06:07'}", remoteid: '', attributevalue: "{ts '2026-03-04 05:06:07'}", datetimevalue: LAUNCH, numericvalue: null });
  });

  // Expected columns are those ACF 2023 (English (US)) inserts for the posted text (extendManager.cfc:503-544).
  it.each<{ value: unknown; attributevalue: string; datetimevalue: Date }>([
    { value: '2026-01-01', attributevalue: "{ts '2026-01-01 00:00:00'}", datetimevalue: new Date(2026, 0, 1) },
    { value: '11.12.2026', attributevalue: "{ts '2026-12-11 00:00:00'}", datetimevalue: new Date(2026, 11, 11) },
    { value: '11-12-2026', attributevalue: "{ts '2026-11-12 00:00:00'}", datetimevalue: new Date(2026, 10, 12) },
    { value: 'November 12, 2026 10:30 AM', attributevalue: "{ts '2026-11-12 10:30:00'}", datetimevalue: new Date(2026, 10, 12, 10, 30) },
    { value: '12345', attributevalue: '12345', datetimevalue: new Date(1933, 9, 18) },
    { value: 12345, attributevalue: '12345', datetimevalue: new Date(1933, 9, 18) },
    { value: "{ts '2026-11-12 10:30:00.999'}", attributevalue: "{ts '2026-11-12 10:30:00'}", datetimevalue: new Date(2026, 10, 12, 10, 30, 1, 0) },
  ])('writes date attribute value $value as $attributevalue with its timestamp', ({ value, attributevalue, datetimevalue }) => {
    const [row] = extendDataRows(BASE_ID, [launch], { siteid: 'tenant-a', ext3: value }, { ...options, siteLocale: 'English (US)' });

    expect(row?.values).toEqual({ stringvalue: attributevalue, remoteid: '', attributevalue, datetimevalue, numericvalue: null });
  });

  it.each<{ value: string; error: Record<string, string> }>([
    { value: 'abc', error: { name: 'Error', message: 'abc is an invalid date or time string.' } },
    { value: '1/1/1500', error: { name: 'Error', message: 'The conversion of a datetime2 data type to a datetime data type resulted in an out-of-range value.' } },
    { value: '   ', error: { name: 'Error', message: 'The cf_sql_timestamp value is empty' } },
    { value: '11/12/2026 10:30:15 AM EST', error: { name: 'LegacyServiceUnavailableError', reason: 'date-text-zone' } },
  ])('refuses date attribute text $value as legacy does', ({ value, error }) => {
    expect(() => extendDataRows(BASE_ID, [launch], { siteid: 'tenant-a', launch: value }, options)).toThrow(expect.objectContaining(error));
  });

  // parseDateTime builds a zone-named instant on a Calendar seeded with the clock, so it keeps the clock's milliseconds.
  it('reads date text naming a time zone at the clock milliseconds', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 11, 23, 1, 22, 250)));
    try {
      const [row] = extendDataRows(BASE_ID, [launch], { siteid: 'tenant-a', launch: '11/12/2026 10:30 EST' }, options);

      expect(row?.values).toMatchObject({ datetimevalue: new Date(Date.UTC(2026, 10, 12, 15, 30, 0, 250)) });
    } finally {
      vi.useRealTimers();
    }
  });

  // ACF 2023 after setLocale(CF2Java(siteLocale)), with the attribute values legacy stores.
  it.each<{ siteLocale: string; value: string; datetimevalue: Date }>([
    { siteLocale: 'German (Standard)', value: '12.11.26', datetimevalue: new Date(2026, 10, 12) },
    { siteLocale: 'de_DE', value: '12. November 2026', datetimevalue: new Date(2026, 10, 12) },
    { siteLocale: 'Japanese', value: '2026/11/12', datetimevalue: new Date(2026, 10, 12) },
    { siteLocale: 'French (Standard)', value: '12/11/2026', datetimevalue: new Date(2026, 10, 12) },
    { siteLocale: 'French (Standard)', value: '2026/11/12', datetimevalue: new Date(2026, 10, 12) },
    { siteLocale: 'Norwegian (Bokmal)', value: '11/12/2026', datetimevalue: new Date(2026, 11, 11) },
  ])('reads date text $value in site locale $siteLocale', ({ siteLocale, value, datetimevalue }) => {
    const [row] = extendDataRows(BASE_ID, [launch], { siteid: 'tenant-a', launch: value }, { ...options, siteLocale });

    expect(row?.values).toMatchObject({ datetimevalue });
  });

  it('fails date text in a site locale setLocale refuses, but stores a Date there', () => {
    const unsupported = { ...options, siteLocale: 'xx' };

    expect(() => extendDataRows(BASE_ID, [launch], { siteid: 'tenant-a', launch: '12.11.2026' }, unsupported)).toThrow(
      expect.objectContaining({ name: 'Error', message: 'xx must be one of the ColdFusion supported locales.' }),
    );
    expect(extendDataRows(BASE_ID, [launch], { siteid: 'tenant-a', launch: LAUNCH }, unsupported)[0]?.values).toMatchObject({ datetimevalue: LAUNCH });
  });

  it('writes an empty value as NULL value columns, or only deletes it when empty values are not saved', () => {
    const data = { siteid: 'tenant-a', ext1: '' };

    expect(extendDataRows(BASE_ID, [color], data, options)[0]?.values).toEqual({ stringvalue: '', remoteid: '', attributevalue: null, datetimevalue: null, numericvalue: null });
    expect(extendDataRows(BASE_ID, [color], data, { saveEmptyExtendedValues: false, siteLocale: '' })[0]?.values).toBeNull();
  });

  it('rejects a complex value as text', () => {
    expect(() => extendDataRows(BASE_ID, [color], { siteid: 'tenant-a', ext1: ['a'] }, options)).toThrow(TypeError);
  });
});

describe('fileAttributeBranches', () => {
  const logo = attribute(5, 'logo', { type: 'File' });

  it.each<{ data: Record<string, unknown>; runs: boolean }>([
    { data: { ext5: 'a.png' }, runs: true },
    { data: { LOGO: 'a.png' }, runs: true },
    { data: { extDelete5: '' }, runs: true },
    { data: { extdeletelogo: 'true' }, runs: true },
    { data: { ext5: '', logo: '' }, runs: false },
    { data: { extDelete5: null }, runs: false },
    { data: {}, runs: false },
  ])('flags the File attribute for $data: $runs', ({ data, runs }) => {
    expect(fileAttributeBranches([logo], data)).toEqual(runs ? [logo] : []);
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
    { name: 'a delete', applied: change({ op: 'delete', before: { siteid: 'tenant-a' }, after: undefined }) },
    { name: 'an insert without its row', applied: change({ op: 'insert', after: undefined }) },
  ])('ignores $name', async ({ applied }) => {
    const { domain, repo } = harness([siteRow('tenant-a')]);

    await domain.emitStateEvents(tenantTx(TENANT_A), applied, write);

    expect(writesOf(repo)).toEqual([]);
    expect(announced()).toEqual([]);
  });

  it.each(['insert', 'update'] as const)('advances the applied site row version under the apply write and announces a site %s with its origin', async (op) => {
    const { domain, repo } = harness([siteRow('tenant-a', { row_version: '41' })]);
    const tx = tenantTx(TENANT_A);

    await domain.emitStateEvents(tx, change({ op, origin: 'backfill' }), write);

    expect(repo.update).toHaveBeenCalledExactlyOnceWith(tx, 'site', { siteid: 'tenant-a' }, { row_version: '42' }, write);
    expect(announced()).toEqual([{ tenantId: TENANT_A, siteId: 'tenant-a', rowVersion: 42n, origin: 'backfill' }]);
    expect(vi.mocked(writeSiteChanged).mock.calls[0]?.[0]).toBe(tx);
  });

  it('fails when the applied site is missing from the apply transaction', async () => {
    const { domain } = harness([]);

    await expect(domain.emitStateEvents(tenantTx(TENANT_A), change(), write)).rejects.toThrow(
      'Applied site tenant-a is missing from its apply transaction',
    );
    expect(announced()).toEqual([]);
  });
});
