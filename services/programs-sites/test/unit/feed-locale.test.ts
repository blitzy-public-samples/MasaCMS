/** configBean's locale from `MURA_LOCALE` in the RSS settings lookup of the composed programs-sites app. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvValidationError } from '@opt2/platform/service-kit';
import { TENANT_A } from '@opt2/platform/testing';
import { buildTestApp, createRecordingDb, headersFor, type RecordingDb } from '../helpers/app.js';

const FEED_SETTINGS_URL = '/internal/v1/sites/feed-settings:lookup';

/** Answers the registry and `programs_sites.site` reads with tenant-a's row. */
function seedSite(db: RecordingDb, sitelocale: string | null): void {
  const row = {
    tenant_id: TENANT_A.tenantId,
    siteid: TENANT_A.siteId,
    domain: `${TENANT_A.siteId}.example.test`,
    usessl: 0,
    extranetssl: 0,
    sitelocale,
    row_version: '1',
  };
  db.respond('FROM programs_sites.tenant_registry WHERE lower(site_id) = lower($1)', (params) =>
    String(params[0]).toLowerCase() === TENANT_A.siteId ? [{ tenant_id: TENANT_A.tenantId, site_id: TENANT_A.siteId }] : [],
  );
  db.respond(/^SELECT \* FROM "programs_sites"\."site" WHERE /i, (params) =>
    params[0] === row.tenant_id && (params[1] === undefined || params[1] === row.siteid) ? [row] : [],
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /internal/v1/sites/feed-settings:lookup configBean locale', () => {
  it.each<{ name: string; locale: string | undefined; sitelocale: string | null; javaLocale: string }>([
    { name: 'MURA_LOCALE for an empty siteLocale', locale: 'German (Standard)', sitelocale: '', javaLocale: 'de_DE' },
    { name: 'MURA_LOCALE for a NULL siteLocale', locale: 'German (Standard)', sitelocale: null, javaLocale: 'de_DE' },
    { name: 'the `Server` default under an unset MURA_LOCALE', locale: undefined, sitelocale: '', javaLocale: 'en_US' },
    { name: 'the `Server` default under an empty MURA_LOCALE', locale: '', sitelocale: '', javaLocale: 'en_US' },
    { name: 'the `Server` default under a ${…} MURA_LOCALE', locale: '${server.locale}', sitelocale: '', javaLocale: 'en_US' },
    { name: 'the `Server` default under a {{…}} MURA_LOCALE', locale: '{{server.locale}}', sitelocale: '', javaLocale: 'en_US' },
    { name: 'CF2Java of a whitespace MURA_LOCALE, kept by setDefaultLocale', locale: '  ', sitelocale: '', javaLocale: 'English (US)' },
    { name: 'the site’s own locale over MURA_LOCALE', locale: 'German (Standard)', sitelocale: 'French (Canadian)', javaLocale: 'fr_CA' },
    { name: 'the site’s own locale under an unset MURA_LOCALE', locale: undefined, sitelocale: 'fr_CA', javaLocale: 'fr_CA' },
  ])('answers $javaLocale from $name', async ({ locale, sitelocale, javaLocale }) => {
    vi.stubEnv('MURA_LOCALE', locale);
    const db = createRecordingDb();
    seedSite(db, sitelocale);
    const { app } = await buildTestApp({ db });
    try {
      const res = await app.inject({
        method: 'POST',
        url: FEED_SETTINGS_URL,
        headers: await headersFor('service:strategies-content'),
        payload: { siteIds: [TENANT_A.siteId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [expect.objectContaining({ siteID: TENANT_A.siteId, javaLocale })] });
    } finally {
      await app.close();
    }
  });

  it('refuses start-up under a MURA_LOCALE with a control character, naming it', async () => {
    vi.stubEnv('MURA_LOCALE', 'German\n(Standard)');

    const build = buildTestApp();

    await expect(build).rejects.toThrow(EnvValidationError);
    await expect(build).rejects.toThrow(/^ {2}MURA_LOCALE: must not contain control characters$/m);
  });
});
