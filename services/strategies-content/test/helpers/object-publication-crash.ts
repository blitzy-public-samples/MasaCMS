/** Exits after the durable put of the published object, past any backup, before the publication transaction commits. */
import { Roles } from '@opt2/platform/auth';
import { sha256Hex } from '@opt2/platform/migration-kit';
import { newRequestContext, runWithRequestContext } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type StoragePort } from '@opt2/platform/storage';
import { createPool, tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, fixedClock } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS } from '../../src/domain/context.js';
import { storeUploadedFile } from '../../src/domain/files.js';
import { storeMigrationObject } from '../../src/migration/objects.js';
import { createContentRepository } from '../../src/repo/repository.js';

const [mode, schema, role, stateDir, fileId, encoded] = process.argv.slice(2);
if (!schema || !role || !stateDir || !encoded || !/^[a-z0-9_]+$/.test(role)) throw new Error('Invalid crash fixture arguments');
const base = await createPool({ env: { ...process.env, OPT2_DB_AUTH: 'password', PG_DATABASE: process.env.PG_DATABASE ?? '' }, schema, max: 1 });
const db: TenantDb = {
  ...base,
  withTenant: (tenantId, fn) => base.withTenant(tenantId, async (tx) => {
    await tx.query(`SET LOCAL ROLE "${role}"`);
    return fn(tx);
  }),
};
const disk = await createLocalStorageAdapter({ stateDir, hmacKey: 'object-publication-test-key' });
const storage: StoragePort = {
  ...disk,
  put: async (bucket, key, body, opts) => {
    const put = await disk.put(bucket, key, body, opts);
    if (key.includes('/.staged/')) return put;
    process.stdout.write(`${JSON.stringify({ key })}\n`);
    process.exit(86);
  },
};
const clock = fixedClock(new Date('2026-06-30T12:00:00.000Z'));
const repository = createContentRepository({ clock, schema });
const bytes = Buffer.from(encoded, 'base64');
if (mode === 'migration' && fileId) {
  await runWithRequestContext({ ...newRequestContext(), service: { name: 'migration', roles: [Roles.platformMigration] } }, () =>
    storeMigrationObject({ db, repository, storage, clock }, {
      tenantId: TENANT_A.tenantId, fileId, variant: '', ext: 'pdf', contentType: 'application/pdf', sha256: sha256Hex(bytes), bytes,
    }),
  );
} else if (mode === 'upload') {
  await storeUploadedFile({ db, repository, storage, clock, config: CONTENT_CONFIG_DEFAULTS }, {
    userId: 'AABBCCDD-0001-4A5B-8C7D9E0F1A2B3C4D', fullName: 'Crash Test', isLoggedIn: true, s2: true,
    roles: [], siteId: TENANT_A.siteId, tenantId: tenantIdForSite(TENANT_A.siteId),
  }, { file: { fieldName: 'newfile', fileName: 'crash.pdf', contentType: 'application/pdf', bytes } });
}
throw new Error('Crash fixture did not reach storage.put');
