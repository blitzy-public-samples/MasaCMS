// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `listExportSheetStatus`: reporting's read of one page of sheet status rows for the running export job it names. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import type { Clock, FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { verifiedExportTenant, type ExportReadScope } from '../domain/export-scope.js';
import type { components } from '../generated/openapi.js';
import { MAX_SHEETS_PER_PAGE, type TimesheetsRepository } from '../repo/repository.js';
import { parseFixtureAsOf } from './fixture.js';
import { sheetStatusPage } from './v1.js';

type ExportSheetStatusPage = components['schemas']['ExportSheetStatusPage'];

/** Fastify path of `listExportSheetStatus`. */
export const EXPORT_SHEET_STATUS_PATH = '/internal/v1/timesheets/sheet-status';

// Reporting's Cloud Tasks runs act as System: only its workload credential is admitted, and no user token is needed or read.
const EXPORT_READ_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([serviceRole('reporting')]) });

const EXPORT_READ_QUERY_SCHEMA = {
  type: 'object',
  required: ['exportId', 'siteId', 'claim', 'asOf', 'pageIndex', 'itemsPerPage'],
  properties: {
    exportId: { type: 'string', pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$' },
    siteId: { type: 'string', minLength: 1, maxLength: 25 },
    claim: { type: 'string', pattern: '^(0|[1-9][0-9]{0,14})$' },
    asOf: { type: 'string' },
    pageIndex: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    itemsPerPage: { type: 'integer', minimum: 1, maximum: MAX_SHEETS_PER_PAGE },
  },
} as const;

type ExportReadQuery = ExportReadScope & { asOf: string; pageIndex: number; itemsPerPage: number };

/** Collaborators of the export read: the timesheets tenant database, repository and clock. */
export type ExportReadDeps = { db: TenantDb; repository: TimesheetsRepository; clock: Clock };

/** Registers `listExportSheetStatus`; reporting confirms the export's scope before the tenant's rows are read. */
export function registerExportReadRoutes(app: FastifyInstance, deps: ExportReadDeps): void {
  app.get<{ Querystring: ExportReadQuery }>(
    EXPORT_SHEET_STATUS_PATH,
    { config: { opt2: EXPORT_READ_AUTH }, schema: { querystring: EXPORT_READ_QUERY_SCHEMA } },
    async (request): Promise<ExportSheetStatusPage> => {
      const { exportId, siteId, claim, asOf, pageIndex, itemsPerPage } = request.query;
      const businessDate = parseFixtureAsOf(asOf, deps.clock);
      if (!businessDate.ok) throw new LegacyApiError('invalidParameters');
      const tenantId = await verifiedExportTenant({ db: deps.db, client: app.opt2.client }, { exportId, siteId, claim }, 'timesheets.sheets');
      return withTenant(deps.db, tenantId, (tx) => sheetStatusPage(tx, deps.repository, { pageIndex, itemsPerPage }, businessDate.asOf));
    },
  );
}
