// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `getExportSourceScope`: the stored scope of an export job, which the finance and timesheets export reads confirm before they read. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import type { FastifyInstance, FastifyRequest } from '@opt2/platform/service-kit';
import { tenantForRegisteredSite, withTenant } from '@opt2/platform/tenancy';
import type { ReportingDeps } from '../domain/deps.js';
import type { components } from '../generated/openapi.js';
import { findDefinition, findJob } from '../repo/queries.js';

type ExportSourceScope = components['schemas']['ExportSourceScope'];

/** Fastify path of `getExportSourceScope`. */
export const EXPORT_SOURCE_SCOPE_PATH = '/internal/v1/exports/:exportId/source-scope';

/** The service whose export read serves each readable source; `broken` is served by none. */
const SOURCE_OWNERS: Readonly<Record<ExportSourceScope['source'], string>> = Object.freeze({
  'timesheets.sheets': 'timesheets',
  'finance.records': 'finance',
});

const SCOPE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('finance'), serviceRole('timesheets')]),
});

const CF_UUID_PATTERN = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$';

const SCOPE_SCHEMA = {
  params: { type: 'object', required: ['exportId'], properties: { exportId: { type: 'string', pattern: CF_UUID_PATTERN } } },
  querystring: { type: 'object', required: ['siteId'], properties: { siteId: { type: 'string', minLength: 1 } } },
} as const;

interface ScopeRequest {
  Params: { exportId: string };
  Querystring: { siteId: string };
}

/** Whether the verified workload of `request` is the service that serves `source`. */
function callerServes(request: FastifyRequest, source: string): source is ExportSourceScope['source'] {
  if (!Object.hasOwn(SOURCE_OWNERS, source)) return false;
  const owner = SOURCE_OWNERS[source as ExportSourceScope['source']];
  return (request.opt2Auth.service?.roles ?? []).includes(serviceRole(owner));
}

/**
 * Job `exportId` as stored under the tenant reporting's own registry gives `siteId`, when its site is `siteId` and its definition
 * reads the calling service's source; null otherwise, so no caller learns of another tenant's or another source's job.
 */
async function sourceScope(deps: Pick<ReportingDeps, 'db'>, request: FastifyRequest, exportId: string, siteId: string): Promise<ExportSourceScope | null> {
  const tenantId = await tenantForRegisteredSite(deps.db, siteId);
  if (tenantId === null) return null;
  return withTenant(deps.db, tenantId, async (tx) => {
    const job = await findJob(tx, exportId);
    // SQL Server compares the fixture's siteID case-insensitively.
    if (job === null || job.siteid.toLowerCase() !== siteId.toLowerCase()) return null;
    const definition = await findDefinition(tx, job.definition_id);
    if (definition === null || !callerServes(request, definition.source)) return null;
    return { exportId: job.job_id, tenantId: job.tenant_id, siteId: job.siteid, source: definition.source, state: job.state, claim: job.row_version };
  });
}

/** Registers `getExportSourceScope` for the export source producers' workloads; an unknown or foreign job answers the legacy 404. */
export function registerExportScopeRoute(app: FastifyInstance, deps: Pick<ReportingDeps, 'db'>): void {
  app.get<ScopeRequest>(EXPORT_SOURCE_SCOPE_PATH, { config: { opt2: SCOPE_AUTH }, schema: SCOPE_SCHEMA }, async (request, reply) => {
    const scope = await sourceScope(deps, request, request.params.exportId, request.query.siteId);
    if (scope === null) {
      // The service's not-found handler answers the legacy 404 envelope.
      reply.callNotFound();
      return reply;
    }
    return scope;
  });
}
