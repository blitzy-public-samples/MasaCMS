/** Firebase doubles of the Identity Platform suites: an app signing with the platform test key, and recorded tenant listings. */
import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type ListTenantsResult, type Tenant } from 'firebase-admin/auth';
import { exportPKCS8 } from 'jose';
import { testSigningKeys } from '@opt2/platform/testing';

/** One recorded `listTenants` page: its tenants and, unless it is the last, the next page token. */
export interface RecordedTenantPage {
  readonly tenants: ReadonlyArray<{ readonly tenantId: string; readonly displayName?: string }>;
  readonly pageToken?: string;
}

/** A Firebase app of project `proj` signing custom tokens with a test key; its credential's access token is `access-1`. */
export async function testFirebaseApp(name: string): Promise<App> {
  const keys = await testSigningKeys();
  const credential = cert({ projectId: 'proj', clientEmail: 'sa@proj.iam.gserviceaccount.com', privateKey: await exportPKCS8(keys.privateKey) });
  credential.getAccessToken = () => Promise.resolve({ access_token: 'access-1', expires_in: 3600 });
  return initializeApp({ projectId: 'proj', credential }, name);
}

/** Makes the app's tenant listing answer `pages` in call order and returns the page token of each call; a call past the last page rejects. */
export function recordTenantListing(app: App, pages: readonly RecordedTenantPage[]): Array<string | undefined> {
  const pageTokens: Array<string | undefined> = [];
  getAuth(app).tenantManager().listTenants = (_maxResults?: number, pageToken?: string): Promise<ListTenantsResult> => {
    const page = pages[pageTokens.length];
    pageTokens.push(pageToken);
    if (page === undefined) return Promise.reject(new Error(`No recorded tenant page for page token ${String(pageToken)}`));
    const tenants = page.tenants.map((tenant) => ({ ...tenant }) as Tenant);
    return Promise.resolve(page.pageToken === undefined ? { tenants } : { tenants, pageToken: page.pageToken });
  };
  return pageTokens;
}
