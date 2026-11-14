/** A throwaway `content` schema with the seeded registry, open gates and local storage for the `domain/content` suites. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createLocalStorageAdapter } from '@opt2/platform/storage';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_UMBRELLA, createThrowawaySchema, fixedClock, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import type { ContentDeps, ContentSaveSite } from '../../src/domain/content.js';
import { CONTENT_CONFIG_DEFAULTS, type Actor, type ContentConfig } from '../../src/domain/context.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

export const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
/** NOW as the repository stores `created` and `lastupdate`: to the second. */
export const NOW_SECOND = new Date(2026, 5, 30, 10, 15, 42, 0);
export const HOME = '00000000000000000000000000000000001';
export const END = '00000000000000000000000000000000END';
export const SITE_TREE = '00000000000000000000000000000000000';
export const SITE_ID = TENANT_A.siteId;

/** A CF-format id whose eight-character first group is `<prefix><n>`. */
export const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(8 - prefix.length, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

/** An S2 administrator of tenant-a (node verdict `editor`, approval-exempt). */
export const ADMIN: Actor = { userId: cfId('U', 1), fullName: 'Admin User', isLoggedIn: true, s2: true, roles: [], siteId: SITE_ID, tenantId: TENANT_A.tenantId };
/** A tenant-a system user without memberships, so without node permission. */
export const NOBODY: Actor = { ...ADMIN, userId: cfId('U', 2), fullName: 'No Body', s2: false, roles: ['system-user'] };

/** tenant-a's site settings: file and category pools in the umbrella site, no site id in URLs. */
export const SITE: ContentSaveSite = {
  siteId: SITE_ID,
  site: 'Tenant A',
  locking: 'None',
  contentApprovalScript: '',
  contentRejectionScript: '',
  contentPendingScript: '',
  contentCanceledScript: '',
  contactEmail: '',
  urls: {
    siteId: SITE_ID,
    scheme: 'http',
    domain: 'localhost',
    requestDomain: 'localhost',
    previewDomain: '',
    serverPort: '',
    context: '',
    siteIdInUrls: false,
    indexFileInUrls: false,
    hashUrls: false,
    useSSL: false,
    filePoolId: TENANT_UMBRELLA.siteId,
    configFileAssetPath: '',
    assetPath: '/sites',
    siteAssetPath: '/sites',
    fileStore: 'fileDir',
    legacyIndexFileLocation: false,
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  },
};

/** The schema, its repository and the content deps of one suite. */
export interface ContentFixture {
  handle: ThrowawaySchema;
  repo: ContentRepository;
  deps: ContentDeps;
  /** `content.<table>` rows of tenant-a matching `where`, ordered by `orderBy` (`content` rows by insertion). */
  rows(table: string, where: string, params?: unknown[], orderBy?: string): Promise<Array<Record<string, unknown>>>;
  /** Runs `fn` in a tenant transaction (tenant-a by default). */
  inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenantId?: string): Promise<T>;
  drop(): Promise<void>;
}

/** Creates the suite's schema, gates, registry and storage; `config` overrides the content config defaults. */
export async function createContentFixture(holderId: string, config: Partial<ContentConfig> = {}): Promise<ContentFixture> {
  const handle = await createThrowawaySchema({
    service: 'strategies-content',
    schemaName: 'content',
    migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
  });
  await ensureUnitGates(handle.app, CONTENT_UNITS);
  await closeGates(handle.app, { units: CONTENT_UNITS, holderId, allowLegacy: true });
  await openGates(handle.app, { units: CONTENT_UNITS, holderId, state: 'open' });
  await seedRegistry(handle.app);
  const clock = fixedClock(NOW);
  const repo = createContentRepository({ clock, schema: handle.schema });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-content-domain-'));
  const storage = await createLocalStorageAdapter({ stateDir, hmacKey: `${holderId}-key` });
  const deps: ContentDeps = { db: handle.app, repository: repo, clock, config: { ...CONTENT_CONFIG_DEFAULTS, ...config }, storage };
  const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>, tenantId: string = TENANT_A.tenantId): Promise<T> => withTenant(handle.app, tenantId, fn);
  return {
    handle,
    repo,
    deps,
    inTenant,
    rows: (table, where, params = [], orderBy = table === 'content' ? 'tcontent_id' : '1') =>
      inTenant(async (tx) => (await tx.query(`SELECT * FROM ${handle.schema}.${table} WHERE ${where} ORDER BY ${orderBy}`, params)).rows as Array<Record<string, unknown>>),
    drop: async () => {
      await handle.drop();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
