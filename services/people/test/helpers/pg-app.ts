/** PostgreSQL scaffolding of the isolation and event suites: the people app over a migrated throwaway schema. */
import { fileURLToPath } from 'node:url';
import type { EventPublisher } from '@opt2/platform/events';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import type { Clock, FastifyInstance } from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, seedRegistry, type CapturingPublisher, type ThrowawaySchema } from '@opt2/platform/testing';
import { SERVICE_NAME } from '../../src/app.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';
import { buildTestApp, type BuildTestAppOptions, type FakeTaskPort, type TestApp } from './app.js';
import type { IdentityDouble } from './identity-double.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const PG_VARIABLES = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'] as const;
const PG_GATE_HOLDER = 'people-test-app';

/** Whether every bootstrap `PG_*` variable is set and the server accepts a connection; `pgAvailable` alone rejects when PG_HOST is set and another is unset. */
async function pgReady(): Promise<boolean> {
  return PG_VARIABLES.every((name) => Boolean(process.env[name])) ? pgAvailable() : false;
}

/** Whether PostgreSQL suites can run, decided once at import, for `describe.skipIf(!PG_AVAILABLE)`. */
export const PG_AVAILABLE: boolean = await pgReady();

/** What {@link withPgApp} answers instead of running its callback. */
export interface PgSkipped {
  readonly skipped: true;
  readonly reason: string;
}

/** A people app over a migrated throwaway schema with the fixture registry and open unit gates. */
export interface PgTestApp<P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher> {
  readonly app: FastifyInstance;
  readonly schema: ThrowawaySchema;
  /** The schema's app-role `TenantDb`, which the app runs on. */
  readonly db: TenantDb;
  readonly identity: IdentityDouble;
  readonly publisher: E;
  readonly clock: Clock;
  readonly taskPort: P;
}

/** Options of {@link withPgApp}: those of {@link buildTestApp} but the database. */
export type WithPgAppOptions<P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher> = Omit<
  BuildTestAppOptions<TenantDb, P, E>,
  'db'
>;

/**
 * Runs `fn` against people over a throwaway schema with every migration applied, the fixture registry seeded and every
 * people unit gate open; then closes the app, removes its state directory and drops the schema, whatever `fn` did.
 * Answers {@link PgSkipped} without calling `fn` when `PG_*` is unset or the server is unreachable.
 */
export function withPgApp<T, P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher>(
  fn: (ctx: PgTestApp<P, E>) => Promise<T>,
  opts?: WithPgAppOptions<P, E>,
): Promise<T | PgSkipped>;
export async function withPgApp<T>(
  fn: (ctx: PgTestApp<TaskPort, EventPublisher>) => Promise<T>,
  opts: WithPgAppOptions<TaskPort, EventPublisher> = {},
): Promise<T | PgSkipped> {
  if (!(await pgReady())) return { skipped: true, reason: 'PostgreSQL is not configured or not reachable through PG_*' };
  const schema = await createThrowawaySchema({ service: SERVICE_NAME, migrationsDir: MIGRATIONS_DIR });
  let built: TestApp<TenantDb, TaskPort, EventPublisher> | undefined;
  try {
    await seedRegistry(schema.app, schema.schema);
    await ensureUnitGates(schema.app, PEOPLE_UNITS);
    // openGates reopens only its holder's gates, so the new `legacy` gates are first closed under this helper's holder.
    await closeGates(schema.app, { units: PEOPLE_UNITS, holderId: PG_GATE_HOLDER, allowLegacy: true });
    await openGates(schema.app, { units: PEOPLE_UNITS, holderId: PG_GATE_HOLDER, state: 'open' });
    built = await buildTestApp({ ...opts, db: schema.app });
    const { app, identity, publisher, clock, taskPort } = built;
    return await fn({ app, schema, db: schema.app, identity, publisher, clock, taskPort });
  } finally {
    try {
      await built?.close();
    } finally {
      await schema.drop();
    }
  }
}
