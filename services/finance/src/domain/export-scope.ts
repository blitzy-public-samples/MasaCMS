// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The tenant an export read of reporting's may be served from, confirmed against the export job reporting stores. */
import { AuthDenial } from '@opt2/platform/auth';
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import { tenantForRegisteredSite, type TenantDb } from '@opt2/platform/tenancy';
import type { components, paths } from '../generated/clients/reporting.js';

type ExportSourceScope = components['schemas']['ExportSourceScope'];

/** Service that owns export jobs. */
export const REPORTING_SERVICE = 'reporting';

const SCOPE_PATH = '/internal/v1/exports/{exportId}/source-scope' satisfies keyof paths;

/** The job, its site and the row version its run claimed it at, as an export read names them. */
export interface ExportReadScope {
  exportId: string;
  siteId: string;
  claim: string;
}

/** Collaborators of {@link verifiedExportTenant}: this service's database, whose registry resolves the site, and its service client. */
export interface ExportScopeDeps {
  db: TenantDb;
  client: ServiceClient;
}

/**
 * The tenant this service's own registry gives `scope.siteId`, once reporting confirms that its job `scope.exportId` is stored under
 * that tenant and site, reads `source` and is running under `scope.claim`. Any other answer is a 403 before a tenant row is read;
 * a reporting that answers 5xx or cannot be reached is the legacy 503.
 */
export async function verifiedExportTenant(deps: ExportScopeDeps, scope: ExportReadScope, source: ExportSourceScope['source']): Promise<string> {
  // Reporting's Cloud Tasks runs act as System, so the stored job, never a caller-supplied tenant or user, scopes the read.
  const tenantId = await tenantForRegisteredSite(deps.db, scope.siteId);
  if (tenantId === null) throw AuthDenial.forbidden();
  const response = await deps.client.request<ExportSourceScope>({
    service: REPORTING_SERVICE,
    method: 'GET',
    path: SCOPE_PATH.replace('{exportId}', encodeURIComponent(scope.exportId)),
    query: { siteId: scope.siteId },
    userToken: null,
  });
  if (response.status >= 500) {
    const cause = Object.assign(new Error(`${REPORTING_SERVICE} answered HTTP ${String(response.status)}`), { code: `HTTP_${String(response.status)}` });
    throw new ServiceUnavailableError(REPORTING_SERVICE, cause);
  }
  const stored: Partial<ExportSourceScope> | null = response.status === 200 && typeof response.body === 'object' ? response.body : null;
  const confirmed =
    stored !== null &&
    stored.exportId === scope.exportId &&
    stored.tenantId === tenantId &&
    typeof stored.siteId === 'string' &&
    stored.siteId.toLowerCase() === scope.siteId.toLowerCase() &&
    stored.source === source &&
    stored.state === 'running' &&
    stored.claim === scope.claim;
  if (!confirmed) throw AuthDenial.forbidden();
  return tenantId;
}
