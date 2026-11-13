// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Registry of the timesheets route modules: the fixture routes and the `/v1/timesheets` routes. */
import type { Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { TimesheetsRepository } from '../repo/repository.js';
import { timesheetsFixturePlugin } from './fixture.js';
import { timesheetsV1Plugin } from './v1.js';

/** Runtime dependencies of every timesheets route module: the timesheets tenant database, repository and clock. */
export interface TimesheetsDeps {
  db: TenantDb;
  repository: TimesheetsRepository;
  clock: Clock;
}

/** Registers the fixture and `/v1` route plugins, each encapsulated so its own error handler covers only its routes. */
export function registerRoutes(app: FastifyInstance, deps: TimesheetsDeps): void {
  void app.register(timesheetsFixturePlugin, deps);
  void app.register(timesheetsV1Plugin, deps);
}
