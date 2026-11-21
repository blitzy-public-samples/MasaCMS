// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `listExportRecords`: reporting's read of one page of finance records for the running export job it names. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { listRecords } from '../domain/records.js';
import { verifiedExportTenant, type ExportReadScope } from '../domain/export-scope.js';
import { requireProgram } from '../legacy/checks.js';
import { recordRow, type FixtureRecord } from '../legacy/serialize.js';

/** Fastify path of `listExportRecords`. */
export const EXPORT_RECORDS_PATH = '/internal/v1/finance/records';

// envelope.cfc's page maximum.
const MAX_PAGE_SIZE = 1000;

// Reporting's Cloud Tasks runs act as System: only its workload credential is admitted, and no user token is needed or read.
const EXPORT_READ_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([serviceRole('reporting')]) });

const EXPORT_READ_QUERY_SCHEMA = {
  type: 'object',
  required: ['exportId', 'siteId', 'claim', 'page', 'pageSize'],
  properties: {
    exportId: { type: 'string', pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$' },
    siteId: { type: 'string', minLength: 1, maxLength: 25 },
    claim: { type: 'string', pattern: '^(0|[1-9][0-9]{0,14})$' },
    page: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
  },
} as const;

type ExportReadQuery = ExportReadScope & { page: number; pageSize: number };

/** Registers `listExportRecords`; reporting confirms the export's scope before the tenant's records are read. */
export function registerExportReadRoutes(app: FastifyInstance, deps: { db: TenantDb }): void {
  app.get<{ Querystring: ExportReadQuery }>(
    EXPORT_RECORDS_PATH,
    { config: { opt2: EXPORT_READ_AUTH }, schema: { querystring: EXPORT_READ_QUERY_SCHEMA } },
    async (request): Promise<{ data: FixtureRecord[]; total: number }> => {
      const { exportId, siteId, claim, page, pageSize } = request.query;
      const tenantId = await verifiedExportTenant({ db: deps.db, client: app.opt2.client }, { exportId, siteId, claim }, 'finance.records');
      // As the record list does, the tenant's program binding is confirmed before its records are read.
      const records = await withTenant(deps.db, tenantId, async (tx) => {
        await requireProgram(tx, tenantId);
        return listRecords(tx, { pageIndex: page, itemsPerPage: pageSize });
      });
      return { data: records.rows.map(recordRow), total: records.total };
    },
  );
}
